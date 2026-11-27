import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { withTenant } from '@scaleinsyght/db';
import { answerLineageRequest, importDbtArtifacts } from '@scaleinsyght/graph';
import { queueProfileJob, runNextDiscovery } from '@scaleinsyght/profiler';
import { activateConnection } from '@scaleinsyght/registry';
import { hashPassword } from '@scaleinsyght/api/server';
import { createGoldenConnector, listGoldenSources } from '../support/golden-connectors.js';

config({ path: '.env' });
const pool = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  const url = new URL(value);
  url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`;
  return new Pool({ connectionString: url.toString() });
};
const app = pool('DATABASE_URL');
const worker = pool('DATABASE_URL_WORKER');
const migrate = pool('DATABASE_URL_MIGRATE');
afterAll(async () => { await Promise.all([app.end(), worker.end(), migrate.end()]); });

it('c6_dbt_source_gaps_close_with_an_assertion_when_the_warehouse_is_profiled', async () => {
  const tenantId = `dbt-relink-${randomUUID()}`;
  const principalId = await withTenant(migrate, tenantId, async db => {
    await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
    return (await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id',
      [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')])).rows[0]!.user_id;
  });
  const { connectionId: warehouse } = await activateConnection(app, { tenantId, principalId, connectorType: 'postgres' });
  const { connectionId: dbt } = await activateConnection(app, { tenantId, principalId, connectorType: 'dbt', sourceRef: `warehouse:${warehouse}` });
  const golden = listGoldenSources().find(source => source.type === 'postgres')!;
  const connector = createGoldenConnector(golden.id);
  const found = (await connector.discover({ mode: 'profile' })).objects.find(item => item.type === 'table')!;
  const [schema, name] = found.qualifiedName.split('.');
  const sourceKey = 'source.fixture.catalog.records';
  const missingKey = 'source.fixture.catalog.absent';
  await importDbtArtifacts(app, {
    tenantId, dbtConnectionId: dbt, warehouseConnectionId: warehouse, warehouseType: 'postgres',
    manifest: {
      metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json' },
      sources: { [sourceKey]: { schema, name }, [missingKey]: { schema, name: 'absent_fixture' } },
      nodes: { 'model.fixture.summary': { resource_type: 'model', schema: 'analytics', name: 'fixture_summary', depends_on: { nodes: [sourceKey, missingKey] } } },
    },
    catalog: { metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/catalog/v1.json' }, nodes: {}, sources: {} },
  });
  const gaps = () => withTenant(app, tenantId, async db => (await db.query(
    'SELECT gap_id,reason,closed_by_assertion_id FROM graph.gaps WHERE tenant_id=$1 ORDER BY gap_id', [tenantId],
  )).rows);
  const before = await gaps();
  const sourceGap = before.find(row => row.reason === `dbt reads ${found.qualifiedName}, which no connected source exposes`);
  const missing = before.find(row => row.reason === `dbt reads ${schema}.absent_fixture, which no connected source exposes`);
  expect(sourceGap).toMatchObject({ closed_by_assertion_id: null });
  expect(missing).toMatchObject({ closed_by_assertion_id: null });

  const profile = async () => {
    await withTenant(app, tenantId, db => queueProfileJob(db, tenantId, warehouse, 'profile'));
    expect(await runNextDiscovery(worker, async () => createGoldenConnector(golden.id), tenantId)).toBe(true);
  };
  await profile();
  const resolved = (await gaps()).find(row => row.gap_id === sourceGap?.gap_id);
  expect(resolved?.closed_by_assertion_id).toEqual(expect.any(String));
  expect((await gaps()).find(row => row.gap_id === missing?.gap_id)).toEqual(missing);
  const edge = await withTenant(app, tenantId, async db => (await db.query(
    `SELECT a.evidence_method, source.qualified_name AS source, model.qualified_name AS model FROM graph.assertions a
     JOIN graph.relationships r USING (tenant_id,relationship_id)
     JOIN graph.assets source ON source.tenant_id=r.tenant_id AND source.asset_id=r.from_asset_id
     JOIN graph.assets model ON model.tenant_id=r.tenant_id AND model.asset_id=r.to_asset_id
     WHERE a.tenant_id=$1 AND a.assertion_id=$2 AND source.source_id=$3`, [tenantId, resolved?.closed_by_assertion_id, warehouse],
  )).rows[0]);
  expect(edge).toEqual({ evidence_method: 'declared', source: found.qualifiedName, model: 'analytics.fixture_summary' });
  const answer = await answerLineageRequest(app, { tenantId, sourceId: warehouse, sourceName: 'Warehouse', asset: 'analytics.fixture_summary', direction: 'upstream' });
  expect(answer.lineage.steps).toEqual(expect.arrayContaining([expect.objectContaining({ from: found.qualifiedName, method: 'declared' })]));
  expect(answer.lineage.gaps.map(gap => gap.reason)).not.toContain(sourceGap?.reason);
  expect(answer.lineage.gaps.map(gap => gap.reason)).toContain(missing?.reason);
  await profile();
  expect((await gaps()).find(row => row.gap_id === resolved?.gap_id)).toEqual(resolved);
});

import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createGoldenConnector } from '@scaleinsyght/connectors';
import { getNotifications, markNotificationRead, runGoldenProfile, saveConnectionScope } from '@scaleinsyght/profiler';

config({ path: '.env' });

function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value);
  url.pathname = '/si_test';
  return url.toString();
}

const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

async function createTenant(tenantId: string): Promise<string> {
  return withTenant(migrate, tenantId, async (client) => {
    await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
    const user = await client.query<{ user_id: string }>(
      `INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic-hash') RETURNING user_id`,
      [tenantId, `${tenantId}@synthetic.example`],
    );
    return user.rows[0]!.user_id;
  });
}

async function connectionFor(tenantId: string, userId: string, type: 'sql_server' | 'postgres' = 'postgres'): Promise<string> {
  return (await activateConnection(app, { tenantId, principalId: userId, connectorType: type })).connectionId;
}

describe('contract 6 profiler persistence and graph', () => {
  afterAll(async () => {
    await app.end();
    await migrate.end();
  });

  it('c6_golden_500_table_schema_harvests_within_ten_minutes_without_model_calls', async () => {
    const tenantId = `profile-500-${crypto.randomUUID()}`;
    const userId = await createTenant(tenantId);
    const connectionId = await connectionFor(tenantId, userId, 'sql_server');
    const connector = createGoldenConnector('golden-sqlserver');
    const result = await runGoldenProfile(app, { tenantId, connectionId, connector, jobType: 'discovery' });
    expect(result.elapsedMs).toBeLessThan(600_000);
    expect(result).toMatchObject({ listed: 500, profiled: 499, inaccessible: 1 });
    expect(connector.modelRequests).toBe(0);
    const persisted = await withTenant(migrate, tenantId, async (client) => client.query<{ jobs: number; datasets: number; inaccessible: number }>(
      `SELECT
        (SELECT count(*)::int FROM profiler.jobs WHERE tenant_id=$1 AND state='COMPLETED') AS jobs,
        (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1 AND asset_type='dataset') AS datasets,
        (SELECT count(*)::int FROM profiler.job_objects WHERE tenant_id=$1 AND state='INACCESSIBLE') AS inaccessible`,
      [tenantId],
    ));
    expect(persisted.rows[0]).toEqual({ jobs: 1, datasets: 499, inaccessible: 1 });
  });

  it('c6_identical_source_profiles_produce_identical_versions_and_foreign_keys_never_become_lineage', async () => {
    const tenantId = `profile-repeat-${crypto.randomUUID()}`;
    const userId = await createTenant(tenantId);
    const connectionId = await connectionFor(tenantId, userId);
    await runGoldenProfile(app, { tenantId, connectionId, connector: createGoldenConnector('golden-postgres'), jobType: 'profile' });
    await runGoldenProfile(app, { tenantId, connectionId, connector: createGoldenConnector('golden-postgres'), jobType: 'profile' });
    const snapshot = await withTenant(migrate, tenantId, async (client) => client.query<{ versions: number; references: number; flows: number; assertions: number }>(
      `SELECT
        (SELECT count(*)::int FROM graph.asset_versions v JOIN graph.assets a USING(tenant_id,asset_id) WHERE v.tenant_id=$1 AND a.qualified_name='X_Golden.Table_001') AS versions,
        (SELECT count(*)::int FROM graph.relationships WHERE tenant_id=$1 AND family='structural' AND relationship_type='REFERENCES') AS references,
        (SELECT count(*)::int FROM graph.relationships WHERE tenant_id=$1 AND family='data_flow') AS flows,
        (SELECT count(*)::int FROM graph.assertions WHERE tenant_id=$1 AND evidence_method='declared' AND verification='unverified') AS assertions`,
      [tenantId],
    ));
    expect(snapshot.rows[0]).toEqual({ versions: 1, references: 1, flows: 0, assertions: 1 });
  });

  it('c6_nightly_refresh_profiles_only_changes_and_creates_read_once_notifications', async () => {
    const tenantId = `profile-nightly-${crypto.randomUUID()}`;
    const userId = await createTenant(tenantId);
    const connectionId = await connectionFor(tenantId, userId);
    const connector = createGoldenConnector('golden-postgres');
    await runGoldenProfile(app, { tenantId, connectionId, connector, jobType: 'discovery' });
    const nightly = await runGoldenProfile(app, { tenantId, connectionId, connector, jobType: 'nightly' });
    expect(nightly).toMatchObject({ profiled: 1, unchanged: 11 });
    const versions = await withTenant(migrate, tenantId, async (client) => client.query<{ name: string; version_count: number }>(
      `SELECT a.qualified_name AS name,count(v.version)::int AS version_count
       FROM graph.assets a JOIN graph.asset_versions v USING(tenant_id,asset_id)
       WHERE a.tenant_id=$1 AND a.asset_type='dataset' GROUP BY a.qualified_name ORDER BY a.qualified_name`,
      [tenantId],
    ));
    expect(versions.rows.find((row) => row.name === 'X_Golden.Table_004')?.version_count).toBe(2);
    expect(versions.rows.find((row) => row.name === 'X_Golden.Table_001')?.version_count).toBe(1);
    const notifications = await getNotifications(app, tenantId, userId);
    expect(notifications).toHaveLength(2);
    expect(notifications.filter((notification) => notification.type === 'nightly')).toHaveLength(1);
    const notification = notifications[0]!;
    expect(await markNotificationRead(app, tenantId, userId, notification.notificationId)).toBe(true);
    expect(await markNotificationRead(app, tenantId, userId, notification.notificationId)).toBe(true);
    expect((await getNotifications(app, tenantId, userId)).find((item) => item.notificationId === notification.notificationId)?.readAt).not.toBeNull();
  });

  it('c6_scope_excludes_and_list_only_objects_from_profiles_and_graph_assets', async () => {
    const tenantId = `profile-scope-${crypto.randomUUID()}`;
    const userId = await createTenant(tenantId);
    const connectionId = await connectionFor(tenantId, userId);
    await saveConnectionScope(app, tenantId, connectionId, [
      { qualifiedName: 'X_Golden.Table_003', objectType: 'table', scopeMode: 'profile' },
      { qualifiedName: 'X_Golden.Table_002', objectType: 'table', scopeMode: 'list_only' },
      { qualifiedName: 'X_Golden.Table_001', objectType: 'table', scopeMode: 'exclude' },
    ]);
    const result = await runGoldenProfile(app, { tenantId, connectionId, connector: createGoldenConnector('golden-postgres'), jobType: 'discovery' });
    expect(result.profiled).toBe(1);
    expect(result.listOnly).toBe(1);
    expect(result.excluded).toBe(10);
    const objects = await withTenant(migrate, tenantId, async (client) => client.query<{ qualified_name: string }>(
      `SELECT qualified_name FROM graph.assets WHERE tenant_id=$1 AND asset_type='dataset' ORDER BY qualified_name`,
      [tenantId],
    ));
    expect(objects.rows.map((row) => row.qualified_name)).toEqual(['X_Golden.Table_003']);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createGoldenConnector } from '../support/golden-connectors.js';
import { getNotifications, markNotificationRead, runProfile, saveConnectionScope } from '@scaleinsyght/profiler';

config({ path: '.env' });

function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value);
  url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
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
    const result = await runProfile(app, { tenantId, connectionId, connector, jobType: 'discovery' });
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

  it('c6_changed_column_statistics_write_a_new_field_version_without_overwriting_history', async () => {
    // A connection profiled before statistics were measured gains them on its next profile run (decision 45).
    const tenantId = `profile-stats-${crypto.randomUUID()}`;
    const userId = await createTenant(tenantId);
    const connectionId = await connectionFor(tenantId, userId);
    const withStatistics = (distinctCount: number | null) => {
      const connector = createGoldenConnector('golden-postgres');
      const profile = connector.profile.bind(connector);
      connector.profile = async (...args: Parameters<typeof profile>) => {
        const result = await profile(...args);
        return { ...result, columns: result.columns.map((column) => column.name === 'display_name'
          ? { ...column, statistics: distinctCount === null ? { nullRate: null, distinctCount: null } : { nullRate: 0, distinctCount, averageLength: 9.5 } } : column) };
      };
      return connector;
    };
    for (const measured of [null, 87, 87, 90]) await runProfile(app, { tenantId, connectionId, connector: withStatistics(measured), jobType: 'profile' });
    const rows = await withTenant(migrate, tenantId, async (client) => client.query<{ profile_version: number; distinct_count: string | null; average_length: number | null }>(
      `SELECT p.profile_version,p.distinct_count::text,p.average_length FROM profiler.field_profiles p JOIN graph.assets a ON a.tenant_id=p.tenant_id AND a.asset_id=p.asset_id
       WHERE p.tenant_id=$1 AND a.qualified_name='X_Golden.Table_001.display_name' ORDER BY p.profile_version`, [tenantId]));
    expect(rows.rows).toEqual([
      { profile_version: 1, distinct_count: null, average_length: null },
      { profile_version: 2, distinct_count: '87', average_length: 9.5 },
      { profile_version: 3, distinct_count: '90', average_length: 9.5 },
    ]);
  });

  it('c6_identical_source_profiles_produce_identical_versions_and_foreign_keys_never_become_lineage', async () => {
    const tenantId = `profile-repeat-${crypto.randomUUID()}`;
    const userId = await createTenant(tenantId);
    const connectionId = await connectionFor(tenantId, userId);
    await runProfile(app, { tenantId, connectionId, connector: createGoldenConnector('golden-postgres'), jobType: 'profile' });
    await runProfile(app, { tenantId, connectionId, connector: createGoldenConnector('golden-postgres'), jobType: 'profile' });
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
    await runProfile(app, { tenantId, connectionId, connector, jobType: 'discovery' });
    const nightly = await runProfile(app, { tenantId, connectionId, connector, jobType: 'nightly' });
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

  it('c6_schema_drop_marks_asset_inactive_and_assertions_stale_but_preserves_history',async()=>{
    const tenantId=`profile-schema-drop-${crypto.randomUUID()}`;
    const userId=await createTenant(tenantId);
    const connectionId=await connectionFor(tenantId,userId);
    const connector=createGoldenConnector('golden-postgres');
    await runProfile(app,{tenantId,connectionId,connector,jobType:'discovery'});
    const droppedName='X_Golden.Table_002';
    await withTenant(migrate,tenantId,async(client)=>{
      const assets=await client.query<{asset_id:string;qualified_name:string}>("SELECT asset_id,qualified_name FROM graph.assets WHERE tenant_id=$1 AND asset_type='dataset' AND qualified_name=ANY($2::text[])",[tenantId,['X_Golden.Table_001',droppedName]]);
      const from=assets.rows.find((asset)=>asset.qualified_name==='X_Golden.Table_001')!.asset_id;
      const to=assets.rows.find((asset)=>asset.qualified_name===droppedName)!.asset_id;
      const relationship=await client.query<{relationship_id:string}>("INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'structural','REFERENCES',$2,$3,'dataset') RETURNING relationship_id",[tenantId,from,to]);
      const evidence=await client.query<{evidence_id:string}>("INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'declared_foreign_key','{\"source\":\"synthetic\"}') RETURNING evidence_id",[tenantId]);
      await client.query("INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,collector_version) VALUES($1,$2,'declared',ARRAY[$3::uuid],'phase3-schema-drop-test')",[tenantId,relationship.rows[0]!.relationship_id,evidence.rows[0]!.evidence_id]);
    });
    const droppedConnector=Object.create(connector) as typeof connector;
    droppedConnector.discover=async(input:Parameters<typeof connector.discover>[0])=>{
      const result=await connector.discover(input);
      const present=(item:{qualifiedName:string})=>item.qualifiedName!==droppedName;
      return {...result,objects:result.objects.filter(present),unchangedObjects:result.unchangedObjects.filter(present),coverage:{...result.coverage,listed:result.coverage.listed-1,accessible:result.coverage.accessible-1}};
    };
    await runProfile(app,{tenantId,connectionId,connector:droppedConnector,jobType:'discovery'});
    const history=await withTenant(migrate,tenantId,async(client)=>client.query<{active:boolean;versions:number;stale_assertions:number}> (
      `SELECT a.active,(SELECT count(*)::int FROM graph.asset_versions v WHERE v.tenant_id=a.tenant_id AND v.asset_id=a.asset_id) versions,
       (SELECT count(*)::int FROM graph.assertions assertion JOIN graph.relationships r USING(tenant_id,relationship_id)
         WHERE assertion.tenant_id=a.tenant_id AND assertion.review_status='stale' AND a.asset_id IN (r.from_asset_id,r.to_asset_id)) stale_assertions
       FROM graph.assets a WHERE a.tenant_id=$1 AND a.qualified_name=$2 AND a.asset_type='dataset'`,[tenantId,droppedName]));
    expect(history.rows[0]).toMatchObject({active:false,versions:1});
    expect(history.rows[0]!.stale_assertions).toBeGreaterThan(0);
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
    const result = await runProfile(app, { tenantId, connectionId, connector: createGoldenConnector('golden-postgres'), jobType: 'discovery' });
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

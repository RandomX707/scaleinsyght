import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { queryLineage } from '@scaleinsyght/graph';

config({ path: '.env' });
const url = process.env.DATABASE_URL_MIGRATE;
if (!url) throw new Error('DATABASE_URL_MIGRATE is required; PostgreSQL contract tests are never skipped');
const testUrl = new URL(url);
testUrl.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
const pool = new Pool({ connectionString: testUrl.toString() });
const appUrl = new URL(process.env.DATABASE_URL ?? '');
appUrl.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
const appPool = new Pool({ connectionString: appUrl.toString() });

describe('c6 lineage and identifier schema contracts', () => {
  afterAll(async () => { await pool.end(); await appPool.end(); });

  it('c6_golden_missing_hop_is_gap_with_no_invented_edge', async () => {
    const tenantId = `phase3-lineage-${crypto.randomUUID()}`;
    await withTenant(pool, tenantId, async (client) => {
      await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      await client.query("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic')", [tenantId,`${tenantId}@synthetic.example`]);
    });
    const connection = await activateConnection(appPool,{tenantId,principalId:(await withTenant(pool,tenantId,async(client)=>(await client.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1',[tenantId])).rows[0]!.user_id)),connectorType:'postgres'});
    const ids = await withTenant(pool,tenantId,async(client)=>{
      const a = await client.query<{asset_id:string}>("INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,'dataset','synthetic.source',decode(repeat('01',32),'hex')) RETURNING asset_id",[tenantId,connection.connectionId]);
      const b = await client.query<{asset_id:string}>("INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,'dataset','synthetic.target',decode(repeat('02',32),'hex')) RETURNING asset_id",[tenantId,connection.connectionId]);
      const c = await client.query<{asset_id:string}>("INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,'dataset','synthetic.origin',decode(repeat('03',32),'hex')) RETURNING asset_id",[tenantId,connection.connectionId]);
      const edge = await client.query<{relationship_id:string}>("INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'data_flow','DERIVES_FROM',$2,$3,'dataset') RETURNING relationship_id",[tenantId,a.rows[0]!.asset_id,b.rows[0]!.asset_id]);
      const priorEdge=await client.query<{relationship_id:string}>("INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'data_flow','DERIVES_FROM',$2,$3,'dataset') RETURNING relationship_id",[tenantId,c.rows[0]!.asset_id,a.rows[0]!.asset_id]);
      const priorEvidence=await client.query<{evidence_id:string}>("INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'sql_parse','{}') RETURNING evidence_id",[tenantId]);
      await client.query("INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,collector_version) VALUES($1,$2,'parsed',ARRAY[$3::uuid],'phase3-fixture')",[tenantId,priorEdge.rows[0]!.relationship_id,priorEvidence.rows[0]!.evidence_id]);
      const evidence = await client.query<{evidence_id:string}>("INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'manifest','{}') RETURNING evidence_id",[tenantId]);
      await client.query("INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,collector_version) VALUES($1,$2,'declared',ARRAY[$3::uuid],'phase3-fixture')",[tenantId,edge.rows[0]!.relationship_id,evidence.rows[0]!.evidence_id]);
      await client.query("INSERT INTO graph.gaps(tenant_id,between_asset_ids,reason) VALUES($1,ARRAY[$2::uuid,$3::uuid],'synthetic manifest omits field mapping')",[tenantId,b.rows[0]!.asset_id,crypto.randomUUID()]);
      return {source:a.rows[0]!.asset_id,target:b.rows[0]!.asset_id,origin:c.rows[0]!.asset_id};
    });
    const lineage=await queryLineage(appPool,{tenantId,assetId:ids.source,direction:'downstream'});
    expect(lineage.asset_ids).toContain(ids.target);
    expect(lineage.assertions).toHaveLength(1);
    expect(lineage.gaps).toHaveLength(1);
    expect(lineage.coverage).toBeLessThan(1);
    const upstream=await queryLineage(appPool,{tenantId,assetId:ids.target,direction:'upstream'});
    expect(upstream.asset_ids).toContain(ids.source);
    const both=await queryLineage(appPool,{tenantId,assetId:ids.target,direction:'both'});
    expect(both.asset_ids).toContain(ids.source);
    expect(both.asset_ids).toContain(ids.origin);
    const beforeCapture=await queryLineage(appPool,{tenantId,assetId:ids.source,direction:'downstream',asOf:new Date('2000-01-01T00:00:00.000Z')});
    expect(beforeCapture.observable).toBe(false);
    expect(beforeCapture.assertions).toHaveLength(0);
    expect(beforeCapture.edges).toHaveLength(0);
    expect(beforeCapture.asset_ids).toEqual([ids.source]);
    const declaredOnly=await queryLineage(appPool,{tenantId,assetId:ids.target,direction:'both',methods:['declared']});
    expect(declaredOnly.asset_ids).not.toContain(ids.origin);
  });

  it('c6_lineage_traversal_stops_at_requested_depth',async()=>{
    const tenantId=`phase3-depth-${crypto.randomUUID()}`;
    const principalId=await withTenant(pool,tenantId,async(client)=>{
      await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
      return (await client.query<{user_id:string}>("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id",[tenantId,`${tenantId}@synthetic.example`])).rows[0]!.user_id;
    });
    const connection=await activateConnection(appPool,{tenantId,principalId,connectorType:'postgres'});
    const ids=await withTenant(pool,tenantId,async(client)=>{
      const assets:string[]=[];
      for(const name of ['synthetic.root','synthetic.middle','synthetic.leaf']){
        const result=await client.query<{asset_id:string}>("INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,'dataset',$3,decode(repeat('01',32),'hex')) RETURNING asset_id",[tenantId,connection.connectionId,name]);
        assets.push(result.rows[0]!.asset_id);
      }
      const relationships=await client.query<{relationship_id:string}>("INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'data_flow','DERIVES_FROM',$2,$3,'dataset'),($1,'data_flow','DERIVES_FROM',$3,$4,'dataset') RETURNING relationship_id",[tenantId,assets[0],assets[1],assets[2]]);
      const evidence=await client.query<{evidence_id:string}>("INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'manifest','{}') RETURNING evidence_id",[tenantId]);
      for(const relationship of relationships.rows)await client.query("INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,collector_version) VALUES($1,$2,'declared',ARRAY[$3::uuid],'phase3-depth-test')",[tenantId,relationship.relationship_id,evidence.rows[0]!.evidence_id]);
      return assets;
    });
    const result=await queryLineage(appPool,{tenantId,assetId:ids[0]!,direction:'downstream',maxDepth:1});
    expect(result.asset_ids).toContain(ids[1]);
    expect(result.asset_ids).not.toContain(ids[2]);
  });

  it('c1_phase3_graph_tables_are_tenant_scoped_and_forced_rls', async () => {
    const result = await pool.query<{ table_name: string; rls: boolean; forced: boolean; has_tenant: boolean }>(
      `SELECT c.relname AS table_name,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
       EXISTS(SELECT 1 FROM information_schema.columns x WHERE x.table_schema='graph' AND x.table_name=c.relname AND x.column_name='tenant_id') AS has_tenant
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='graph' AND c.relname IN ('id_fields','id_fingerprints','id_path_steps','snapshots','events') ORDER BY c.relname`,
    );
    expect(result.rows).toHaveLength(5);
    for (const row of result.rows) expect(row).toMatchObject({ rls: true, forced: true, has_tenant: true });
  });

  it('c5_report_impact_notifications_use_a_typed_safe_notification_kind', async () => {
    const result=await pool.query<{definition:string}>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='core.notifications'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%notification_type%'`);
    expect(result.rows[0]?.definition).toContain('report_impact');
  });

  it('c6_assertions_expose_temporal_validity_and_graph_events_are_append_only', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='graph' AND table_name='assertions'`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(['valid_from', 'valid_to']));
    const trigger = await pool.query<{ trigger_name: string }>(
      `SELECT trigger_name FROM information_schema.triggers WHERE event_object_schema='graph' AND event_object_table='events'`,
    );
    expect(trigger.rows.map((row) => row.trigger_name)).toContain('graph_events_immutable');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tenantId = `phase3-event-${crypto.randomUUID()}`;
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const inserted = await client.query<{ event_id: string }>(
        `INSERT INTO graph.events(tenant_id,event_type,safe_payload) VALUES($1,'metadata_imported','{"fixture":"phase3"}') RETURNING event_id`,
        [tenantId],
      );
      await expect(client.query('UPDATE graph.events SET safe_payload=$1 WHERE tenant_id=$2 AND event_id=$3', [{ changed: true }, tenantId, inserted.rows[0]!.event_id])).rejects.toThrow('graph events are immutable');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

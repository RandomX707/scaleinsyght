import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { fingerprintIdentifier } from '@scaleinsyght/graph';
import { activateConnection } from '@scaleinsyght/registry';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL'|'DATABASE_URL_MIGRATE'): string {
  const value=process.env[key];if(!value)throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url=new URL(value);url.pathname='/si_test';return url.toString();
}
const app=new Pool({connectionString:testUrl('DATABASE_URL')});
const migrate=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});

describe('c6 synthetic metadata import',()=>{
  afterAll(async()=>{await app.end();await migrate.end();});
  it('c6_importing_the_same_fixture_twice_reuses_connection_and_keeps_fact_counts_unchanged',async()=>{
    const tenantId=`phase3-idempotent-${crypto.randomUUID()}`;
    await withTenant(migrate,tenantId,async(client)=>{
      await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
      await client.query("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)",[tenantId,`${tenantId}@synthetic.example`,hashPassword('synthetic-password')]);
    });
    const server=await buildServer({pool:app,sessionSecret:'s'.repeat(64),goldenAccounts:[{tenantId,email:`${tenantId}@synthetic.example`}]});
    try{
      const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email:`${tenantId}@synthetic.example`,password:'synthetic-password'}});
      const cookie=login.headers['set-cookie']!.split(';')[0]!;
      const importFixture=async()=>{
        const draft=await server.inject({method:'POST',url:'/api/metadata/connections',headers:{cookie},payload:{sourceId:'golden-powerbi'}});
        expect(draft.statusCode,draft.body).toBe(201);
        const connectionId=(draft.json() as {connectionId:string}).connectionId;
        expect((await server.inject({method:'POST',url:`/api/metadata/connections/${connectionId}/activate`,headers:{cookie}})).statusCode).toBe(200);
        expect((await server.inject({method:'POST',url:`/api/metadata/import/${connectionId}`,headers:{cookie},payload:{fixtureKey:'power-bi-reports'}})).statusCode).toBe(200);
        return connectionId;
      };
      const firstConnection=await importFixture();
      const before=await withTenant(migrate,tenantId,async(client)=>client.query<{connections:number;assets:number;relationships:number;assertions:number;evidence:number;events:number;snapshots:number}>(
        `SELECT (SELECT count(*)::int FROM registry.connections WHERE tenant_id=$1 AND source_ref='golden-powerbi' AND status='active') connections,
         (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1) assets,
         (SELECT count(*)::int FROM graph.relationships WHERE tenant_id=$1) relationships,
         (SELECT count(*)::int FROM graph.assertions WHERE tenant_id=$1) assertions,
         (SELECT count(*)::int FROM graph.evidence WHERE tenant_id=$1) evidence,
         (SELECT count(*)::int FROM graph.events WHERE tenant_id=$1) events,
         (SELECT count(*)::int FROM graph.snapshots WHERE tenant_id=$1) snapshots`,[tenantId]));
      const secondConnection=await importFixture();
      const after=await withTenant(migrate,tenantId,async(client)=>client.query<{connections:number;assets:number;relationships:number;assertions:number;evidence:number;events:number;snapshots:number}>(
        `SELECT (SELECT count(*)::int FROM registry.connections WHERE tenant_id=$1 AND source_ref='golden-powerbi' AND status='active') connections,
         (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1) assets,
         (SELECT count(*)::int FROM graph.relationships WHERE tenant_id=$1) relationships,
         (SELECT count(*)::int FROM graph.assertions WHERE tenant_id=$1) assertions,
         (SELECT count(*)::int FROM graph.evidence WHERE tenant_id=$1) evidence,
         (SELECT count(*)::int FROM graph.events WHERE tenant_id=$1) events,
         (SELECT count(*)::int FROM graph.snapshots WHERE tenant_id=$1) snapshots`,[tenantId]));
      expect(secondConnection).toBe(firstConnection);
      expect(before.rows[0]!.relationships).toBeGreaterThan(0);
      expect(before.rows[0]!.assertions).toBeGreaterThan(0);
      expect(before.rows[0]!.evidence).toBeGreaterThan(0);
      expect(after.rows[0]).toEqual(before.rows[0]);
    }finally{await server.close();}
  });
  it('c6_dbt_tableau_power_bi_golden_imports_create_typed_assets_events_and_report_links',async()=>{
    const tenantId=`phase3-tool-${crypto.randomUUID()}`;
    await withTenant(migrate,tenantId,async(client)=>{
      await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
      await client.query("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)",[tenantId,`${tenantId}@synthetic.example`,hashPassword('synthetic-password')]);
    });
    const principal=await withTenant(migrate,tenantId,async(client)=>(await client.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1',[tenantId])).rows[0]!.user_id);
    const sqlConnection=await activateConnection(app,{tenantId,principalId:principal,connectorType:'sql_server',sourceRef:'golden-sqlserver'});
    const snowflakeConnection=await activateConnection(app,{tenantId,principalId:principal,connectorType:'snowflake',sourceRef:'golden-snowflake'});
    await withTenant(migrate,tenantId,async(client)=>{
      for(const [connectionId,name] of [
        [sqlConnection.connectionId,'SyntheticSQL.Customer'],[sqlConnection.connectionId,'SyntheticSQL.Customer.customer_id'],
        [snowflakeConnection.connectionId,'SyntheticSnowflake.DIM_CUSTOMER'],[snowflakeConnection.connectionId,'SyntheticSnowflake.DIM_CUSTOMER.customer_key'],
      ])await client.query("INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,$3,$4,decode(md5($4),'hex'))",[tenantId,connectionId,name.split('.').length>2?'field':'dataset',name]);
    });
    const server=await buildServer({pool:app,sessionSecret:'s'.repeat(64),goldenAccounts:[{tenantId,email:`${tenantId}@synthetic.example`}]});
    try{
      const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email:`${tenantId}@synthetic.example`,password:'synthetic-password'}});
      const cookie=login.headers['set-cookie']!.split(';')[0]!;
      const draft=await server.inject({method:'POST',url:'/api/metadata/connections',headers:{cookie},payload:{sourceId:'golden-dbt'}});
      expect(draft.statusCode,draft.body).toBe(201);
      const connectionId=(draft.json() as {connectionId:string}).connectionId;
      expect((await server.inject({method:'POST',url:`/api/metadata/connections/${connectionId}/activate`,headers:{cookie}})).statusCode).toBe(200);
      const imported=await server.inject({method:'POST',url:`/api/metadata/import/${connectionId}`,headers:{cookie},payload:{fixtureKey:'dbt-manifest'}});
      expect(imported.statusCode).toBe(200);
      expect((imported.json() as {assets:number}).assets).toBeGreaterThan(0);
      expect((await server.inject({method:'POST',url:`/api/metadata/import/${connectionId}`,headers:{cookie},payload:{fixtureKey:'dbt-manifest'}})).statusCode).toBe(200);
      for(const [sourceId,fixtureKey] of [['golden-tableau','tableau-reports'],['golden-powerbi','power-bi-reports']] as const){
        const otherDraft=await server.inject({method:'POST',url:'/api/metadata/connections',headers:{cookie},payload:{sourceId}});
        expect(otherDraft.statusCode).toBe(201);
        const otherConnection=(otherDraft.json() as {connectionId:string}).connectionId;
        expect((await server.inject({method:'POST',url:`/api/metadata/connections/${otherConnection}/activate`,headers:{cookie}})).statusCode).toBe(200);
        expect((await server.inject({method:'POST',url:`/api/metadata/import/${otherConnection}`,headers:{cookie},payload:{fixtureKey}})).statusCode).toBe(200);
      }
      const notices=await server.inject({method:'GET',url:'/api/notifications',headers:{cookie}});
      expect((notices.json() as {notifications:Array<{type:string}>}).notifications.map((item)=>item.type)).toContain('report_impact');
      const reports=await server.inject({method:'GET',url:'/api/reports',headers:{cookie}});
      expect(reports.statusCode).toBe(200);
      expect(JSON.stringify(reports.json())).toContain('Power BI.Customer Health');
      expect((reports.json() as {reports:Array<{name:string;safe_path:string|null}>}).reports.find(item=>item.name==='Power BI.Customer Health')?.safe_path).toBe('/demo/power-bi/customer-health');
      const changedAsset=await withTenant(migrate,tenantId,async(client)=>(await client.query<{asset_id:string}>("SELECT asset_id FROM graph.assets WHERE tenant_id=$1 AND qualified_name='dbt.customer_mart.customer_key' LIMIT 1",[tenantId])).rows[0]!.asset_id);
      const impact=await server.inject({method:'GET',url:`/api/lineage/${changedAsset}/impact`,headers:{cookie}});
      expect(impact.statusCode).toBe(200);
      expect(JSON.stringify(impact.json())).toContain('Power BI.Customer Health');
      const snapshots=await server.inject({method:'GET',url:'/api/lineage/snapshots',headers:{cookie}});
      expect(snapshots.statusCode).toBe(200);
      const snapshotRows=(snapshots.json() as {snapshots:Array<{snapshot_id:string}>}).snapshots;
      expect(snapshotRows.length).toBeGreaterThanOrEqual(2);
      const comparison=await server.inject({method:'GET',url:`/api/lineage/snapshots/${snapshotRows[0]!.snapshot_id}/compare/${snapshotRows.at(-1)!.snapshot_id}`,headers:{cookie}});
      expect(comparison.statusCode).toBe(200);
      expect((comparison.json() as {changes:Array<{event_type:string}>}).changes.map((item)=>item.event_type)).toContain('metadata_imported');
      expect((await server.inject({method:'POST',url:`/api/metadata/import/${connectionId}`,headers:{cookie},payload:{fixtureKey:'../../other'}})).statusCode).toBe(400);
      const idField=await withTenant(migrate,tenantId,async(client)=>{
        const row=await client.query<{asset_id:string;field_name:string}>('SELECT asset_id,field_name FROM graph.id_fields WHERE tenant_id=$1 LIMIT 1',[tenantId]);
        const value='SYNTHETIC-CUSTOMER-IDENTIFIER-NEVER-PERSIST';
        const fingerprint=fingerprintIdentifier(Buffer.from(process.env.ARTIFACT_MASTER_KEY!,'base64'),tenantId,value);
        await client.query('INSERT INTO graph.id_fingerprints(tenant_id,asset_id,field_name,fingerprint,key_version) VALUES($1,$2,$3,$4,1)',[tenantId,row.rows[0]!.asset_id,row.rows[0]!.field_name,Buffer.from(fingerprint,'hex')]);
        return {...row.rows[0]!,value};
      });
      const trace=await server.inject({method:'POST',url:`/api/ids/${idField.asset_id}/trace`,headers:{cookie},payload:{value:idField.value}});
      expect(trace.statusCode).toBe(200);
      expect(JSON.stringify(trace.json())).toContain(idField.field_name);
      expect(JSON.stringify(trace.json())).not.toContain(idField.value);
      const listed=await server.inject({method:'GET',url:'/api/ids',headers:{cookie}});
      expect(listed.statusCode).toBe(200);
      expect(JSON.stringify(listed.json())).not.toContain(fingerprintIdentifier(Buffer.from(process.env.ARTIFACT_MASTER_KEY!,'base64'),tenantId,idField.value));
      const path=await server.inject({method:'GET',url:`/api/ids/${idField.asset_id}/path`,headers:{cookie}});
      expect(path.statusCode, path.body).toBe(200);
      expect(JSON.stringify(path.json())).toContain(idField.field_name);
      expect(path.json() as {complete:boolean;gapIds:string[];fields:Array<unknown>;confidence:number}).toMatchObject({complete:false,confidence:0.62});
      expect((path.json() as {gapIds:string[]}).gapIds).toHaveLength(1);
      expect((path.json() as {fields:unknown[]}).fields).toHaveLength(3);
      const persistedIdentifiers=await withTenant(migrate,tenantId,async(client)=>client.query<{raw_matches:number}>(
        `SELECT ((SELECT count(*) FROM graph.assets WHERE tenant_id=$1 AND qualified_name LIKE '%'||$2||'%')+
         (SELECT count(*) FROM graph.evidence WHERE tenant_id=$1 AND safe_metadata::text LIKE '%'||$2||'%')+
         (SELECT count(*) FROM graph.events WHERE tenant_id=$1 AND safe_payload::text LIKE '%'||$2||'%')+
         (SELECT count(*) FROM graph.assertions WHERE tenant_id=$1 AND coalesce(explanation,'') LIKE '%'||$2||'%'))::int raw_matches`,[tenantId,idField.value]));
      expect(persistedIdentifiers.rows[0]?.raw_matches).toBe(0);
      const assertion=await withTenant(migrate,tenantId,async(client)=>{
        const user=await client.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1',[tenantId]);
        const row=await client.query<{assertion_id:string;from_asset_id:string;to_asset_id:string;granularity:string}>(
          `SELECT a.assertion_id,r.from_asset_id,r.to_asset_id,r.granularity FROM graph.assertions a JOIN graph.relationships r USING(tenant_id,relationship_id)
           WHERE a.tenant_id=$1 AND r.granularity='field' LIMIT 1`,[tenantId]);
        const runId=crypto.randomUUID();
        await client.query("INSERT INTO runs.runs(tenant_id,run_id,principal_id,state) VALUES($1,$2,$3,'COMPLETED')",[tenantId,runId,user.rows[0]!.user_id]);
        await client.query("INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,safe_payload) VALUES($1,$2,1,'lineage_observed',$3::jsonb),($1,$2,2,'run_terminal','{\"state\":\"COMPLETED\"}')",[tenantId,runId,JSON.stringify({lineage:[{from_asset_id:row.rows[0]!.from_asset_id,to_asset_id:row.rows[0]!.to_asset_id,granularity:row.rows[0]!.granularity}]})]);
        return {...row.rows[0]!,runId};
      });
      const review=await server.inject({method:'POST',url:`/api/lineage/assertions/${assertion.assertion_id}/review`,headers:{cookie},payload:{status:'accepted'}});
      expect(review.statusCode).toBe(200);
      expect((review.json() as {verification:string}).verification).toBe('unverified');
      const mismatchRun=crypto.randomUUID();
      await withTenant(migrate,tenantId,async(client)=>{
        const user=await client.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1',[tenantId]);
        await client.query("INSERT INTO runs.runs(tenant_id,run_id,principal_id,state) VALUES($1,$2,$3,'COMPLETED')",[tenantId,mismatchRun,user.rows[0]!.user_id]);
        await client.query("INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,safe_payload) VALUES($1,$2,1,'lineage_observed',$3::jsonb),($1,$2,2,'run_terminal','{\"state\":\"COMPLETED\"}')",[tenantId,mismatchRun,JSON.stringify({lineage:[{from_asset_id:assertion.from_asset_id,to_asset_id:crypto.randomUUID(),granularity:assertion.granularity}]})]);
      });
      expect((await server.inject({method:'POST',url:`/api/lineage/assertions/${assertion.assertion_id}/verify`,headers:{cookie},payload:{runId:mismatchRun}})).statusCode).toBe(409);
      const verified=await server.inject({method:'POST',url:`/api/lineage/assertions/${assertion.assertion_id}/verify`,headers:{cookie},payload:{runId:assertion.runId}});
      expect(verified.statusCode).toBe(200);
      expect((verified.json() as {verification:string}).verification).toBe('run_verified');
      const reconciliationId=await withTenant(migrate,tenantId,async(client)=>{
        const row=await client.query<{evidence_id:string}>(`INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'reconciliation',$2::jsonb) RETURNING evidence_id`,[tenantId,JSON.stringify({from_asset_id:assertion.from_asset_id,to_asset_id:assertion.to_asset_id,granularity:assertion.granularity})]);
        return row.rows[0]!.evidence_id;
      });
      const reconciled=await server.inject({method:'POST',url:`/api/lineage/assertions/${assertion.assertion_id}/reconcile`,headers:{cookie},payload:{evidenceId:reconciliationId}});
      expect(reconciled.statusCode).toBe(200);
      expect((reconciled.json() as {verification:string}).verification).toBe('reconciled');
    }finally{await server.close();}
      const persisted=await withTenant(migrate,tenantId,async(client)=>{
      const principal=await client.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1',[tenantId]);
      await client.query("SELECT set_config('app.principal_id',$1,true)",[principal.rows[0]!.user_id]);
      return client.query<{datasets:number;reports:number;flows:number;assertions:number;events:number;id_fields:number;impacts:number;id_path_steps:number}>(
      `SELECT (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1 AND asset_type='dataset') datasets,
       (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1 AND asset_type='report') reports,
       (SELECT count(*)::int FROM graph.relationships WHERE tenant_id=$1 AND family='data_flow') flows,
       (SELECT count(*)::int FROM graph.assertions WHERE tenant_id=$1) assertions,
       (SELECT count(*)::int FROM graph.events WHERE tenant_id=$1 AND event_type='metadata_imported') events,
       (SELECT count(*)::int FROM graph.id_fields WHERE tenant_id=$1) id_fields,
       (SELECT count(*)::int FROM core.notifications WHERE tenant_id=$1 AND notification_type='report_impact') impacts,
       (SELECT count(*)::int FROM graph.id_path_steps WHERE tenant_id=$1) id_path_steps`,[tenantId]);
    });
    expect(persisted.rows[0]).toMatchObject({datasets:expect.any(Number),reports:expect.any(Number),flows:expect.any(Number),assertions:expect.any(Number),events:3});
    expect(persisted.rows[0]!.datasets).toBeGreaterThan(0);
    expect(persisted.rows[0]!.reports).toBeGreaterThan(0);
    expect(persisted.rows[0]!.id_fields).toBe(3);
    expect(persisted.rows[0]!.id_path_steps).toBeGreaterThanOrEqual(3);
    expect(persisted.rows[0]!.impacts).toBe(1);
  });
});

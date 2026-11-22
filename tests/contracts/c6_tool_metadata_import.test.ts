import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL'|'DATABASE_URL_MIGRATE'): string {
  const value=process.env[key];if(!value)throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url=new URL(value);url.pathname='/si_test';return url.toString();
}
const app=new Pool({connectionString:testUrl('DATABASE_URL')});
const migrate=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});

describe('c6 synthetic metadata import',()=>{
  afterAll(async()=>{await app.end();await migrate.end();});
  it('c6_dbt_tableau_power_bi_golden_imports_create_typed_assets_events_and_report_links',async()=>{
    const tenantId=`phase3-tool-${crypto.randomUUID()}`;
    await withTenant(migrate,tenantId,async(client)=>{
      await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
      await client.query("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)",[tenantId,`${tenantId}@synthetic.example`,hashPassword('synthetic-password')]);
    });
    const server=await buildServer({pool:app,sessionSecret:'s'.repeat(64),goldenAccounts:[{tenantId,email:`${tenantId}@synthetic.example`}]});
    try{
      const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email:`${tenantId}@synthetic.example`,password:'synthetic-password'}});
      const cookie=login.headers['set-cookie']!.split(';')[0]!;
      const draft=await server.inject({method:'POST',url:'/api/metadata/connections',headers:{cookie},payload:{sourceId:'golden-dbt'}});
      expect(draft.statusCode).toBe(201);
      const connectionId=(draft.json() as {connectionId:string}).connectionId;
      expect((await server.inject({method:'POST',url:`/api/metadata/connections/${connectionId}/activate`,headers:{cookie}})).statusCode).toBe(200);
      const imported=await server.inject({method:'POST',url:`/api/metadata/import/${connectionId}`,headers:{cookie},payload:{fixtureKey:'dbt-manifest'}});
      expect(imported.statusCode).toBe(200);
      expect((imported.json() as {assets:number}).assets).toBeGreaterThan(0);
      expect((await server.inject({method:'POST',url:`/api/metadata/import/${connectionId}`,headers:{cookie},payload:{fixtureKey:'../../other'}})).statusCode).toBe(400);
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
    const persisted=await withTenant(migrate,tenantId,async(client)=>client.query<{datasets:number;reports:number;flows:number;assertions:number;events:number}>(
      `SELECT (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1 AND asset_type='dataset') datasets,
       (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1 AND asset_type='report') reports,
       (SELECT count(*)::int FROM graph.relationships WHERE tenant_id=$1 AND family='data_flow') flows,
       (SELECT count(*)::int FROM graph.assertions WHERE tenant_id=$1) assertions,
       (SELECT count(*)::int FROM graph.events WHERE tenant_id=$1 AND event_type='metadata_imported') events`,[tenantId]));
    expect(persisted.rows[0]).toMatchObject({datasets:expect.any(Number),reports:expect.any(Number),flows:expect.any(Number),assertions:expect.any(Number),events:1});
    expect(persisted.rows[0]!.datasets).toBeGreaterThan(0);
    expect(persisted.rows[0]!.reports).toBeGreaterThan(0);
  });
});

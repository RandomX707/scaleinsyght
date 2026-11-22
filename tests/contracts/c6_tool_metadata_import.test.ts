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

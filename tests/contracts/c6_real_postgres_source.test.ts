import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, Client } from 'pg';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';

config({ path: '.env' });
const sourceUrl=process.env.DATABASE_URL_SAMPLE_SOURCE;
if(!sourceUrl)throw new Error('DATABASE_URL_SAMPLE_SOURCE is required for the real PostgreSQL connector contract; run pnpm db:setup:sample');
function testUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'):string{
  const value=process.env[key];if(!value)throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url=new URL(value);url.pathname='/si_test';return url.toString();
}
const appPool=new Pool({connectionString:testUrl('DATABASE_URL')});
const migratePool=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});

describe('contract 6 real PostgreSQL source connector',()=>{
  afterAll(async()=>{await appPool.end();await migratePool.end();});
  it('real_postgres_read_only_connector_harvests_profiles_infers_er_dictionary_and_nightly_refresh',async()=>{
    const tenantId=`real-postgres-${crypto.randomUUID()}`;
    await withTenant(migratePool,tenantId,async(db)=>{
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
      await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)',[tenantId,`${tenantId}@synthetic.example`,hashPassword('synthetic-password')]);
    });
    const server=await buildServer({pool:appPool,sessionSecret:'p'.repeat(64),goldenAccounts:[{tenantId,email:`${tenantId}@synthetic.example`}]});
    const source=new Client({connectionString:sourceUrl});
    try{
      const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email:`${tenantId}@synthetic.example`,password:'synthetic-password'}});
      const cookie=String(login.headers['set-cookie']);expect(login.statusCode).toBe(200);
      const listed=await server.inject({method:'GET',url:'/api/sources',headers:{cookie}});
      expect(listed.json().sources).toContainEqual(expect.objectContaining({id:'local-hospital',type:'postgres'}));
      const draft=await server.inject({method:'POST',url:'/api/connections',headers:{cookie},payload:{sourceId:'local-hospital'}});
      expect(draft.statusCode).toBe(201);
      const connectionId=(draft.json() as {connectionId:string}).connectionId;
      expect((await server.inject({method:'POST',url:`/api/connections/${connectionId}/test`,headers:{cookie}})).statusCode).toBe(200);
      const activated=await server.inject({method:'POST',url:`/api/connections/${connectionId}/activate`,headers:{cookie},payload:{scope:[]}});
      expect(activated.statusCode).toBe(200);
      expect((activated.json() as {profile:{listed:number;profiled:number}}).profile).toMatchObject({listed:5,profiled:5});
      const profile=await server.inject({method:'GET',url:`/api/connections/${connectionId}/profile`,headers:{cookie}});
      expect(profile.json().profile).toMatchObject({job_type:'discovery',listed_count:5,profiled_count:5});
      const dictionary=await server.inject({method:'GET',url:`/api/connections/${connectionId}/dictionary`,headers:{cookie}});
      expect(dictionary.statusCode).toBe(200);expect(dictionary.json().tables).toHaveLength(5);
      const er=await server.inject({method:'GET',url:`/api/connections/${connectionId}/er`,headers:{cookie}});
      expect(er.statusCode).toBe(200);expect(er.json().relationships.length).toBeGreaterThanOrEqual(4);
      const dbtDraft=await server.inject({method:'POST',url:'/api/metadata/connections',headers:{cookie},payload:{sourceId:'local-dbt-manifest'}});
      expect(dbtDraft.statusCode).toBe(201);const dbtConnectionId=(dbtDraft.json() as {connectionId:string}).connectionId;
      expect((await server.inject({method:'POST',url:`/api/metadata/connections/${dbtConnectionId}/activate`,headers:{cookie}})).statusCode).toBe(200);
      const manifest=JSON.parse(readFileSync(resolve('.local/dbt/target/manifest.json'),'utf8')) as unknown;
      const imported=await server.inject({method:'POST',url:`/api/metadata/import/${dbtConnectionId}`,headers:{cookie},payload:{manifest,sourceConnectionId:connectionId}});
      expect(imported.statusCode).toBe(200);expect(imported.json()).toMatchObject({assets:1,flows:1});
      const importedAgain=await server.inject({method:'POST',url:`/api/metadata/import/${dbtConnectionId}`,headers:{cookie},payload:{manifest,sourceConnectionId:connectionId}});
      expect(importedAgain.statusCode).toBe(200);
      const dbtCounts=await withTenant(migratePool,tenantId,async(db)=>db.query<{assets:number;flows:number;assertions:number}>(
        `SELECT (SELECT count(*)::int FROM graph.assets WHERE tenant_id=$1 AND source_id=$2) AS assets,
          (SELECT count(*)::int FROM graph.relationships r JOIN graph.assets a ON a.tenant_id=r.tenant_id AND a.asset_id=r.from_asset_id WHERE r.tenant_id=$1 AND a.source_id=$2) AS flows,
          (SELECT count(*)::int FROM graph.assertions WHERE tenant_id=$1 AND collector_version='phase5b-dbt-manifest-v1') AS assertions`,[tenantId,dbtConnectionId]));
      expect(dbtCounts.rows[0]).toEqual({assets:1,flows:1,assertions:1});
      const nightly=await server.inject({method:'POST',url:`/api/connections/${connectionId}/discover`,headers:{cookie},payload:{jobType:'nightly'}});
      expect(nightly.statusCode).toBe(200);expect(nightly.json()).toMatchObject({listed:5,profiled:0,unchanged:5});
      await source.connect();
      const privileges=await source.query<{database_create:boolean;schema_create:boolean;table_insert:boolean;table_truncate:boolean;table_owner:boolean}>(`SELECT has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
        has_schema_privilege(current_user,'public','CREATE') AS schema_create,
        has_table_privilege(current_user,'public.departments','INSERT') AS table_insert,
        has_table_privilege(current_user,'public.departments','TRUNCATE') AS table_truncate,
        pg_has_role(current_user,(SELECT tableowner::regrole::text FROM pg_tables WHERE schemaname='public' AND tablename='departments'),'MEMBER') AS table_owner`);
      expect(privileges.rows[0]).toEqual({database_create:false,schema_create:false,table_insert:false,table_truncate:false,table_owner:false});
      await expect(source.query("INSERT INTO public.departments(department_id,department_code,department_name) VALUES(99,'D-099','forbidden')")).rejects.toThrow();
    }finally{
      await source.end().catch(()=>undefined);
      await server.close();
    }
  });
});

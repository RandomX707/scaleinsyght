import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { activateConnection } from '@scaleinsyght/registry';
import { withTenant } from '@scaleinsyght/db';

config({path:'.env'});
function url(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'):string{const value=process.env[key];if(!value)throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);const parsed=new URL(value);parsed.pathname='/si_test';return parsed.toString();}
const app=new Pool({connectionString:url('DATABASE_URL')});const migrate=new Pool({connectionString:url('DATABASE_URL_MIGRATE')});
describe('contract 1 authorized analytic source discovery',()=>{
 afterAll(async()=>{await app.end();await migrate.end();});
 it('c1_analytic_source_selector_lists_only_authorized_active_sources',async()=>{
  const tenantId=`source-selector-${crypto.randomUUID()}`;let principalId='';
  await withTenant(migrate,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);principalId=(await db.query<{user_id:string}>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id',[tenantId,`${tenantId}@synthetic.example`,hashPassword('synthetic-password')])).rows[0]!.user_id;await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)",[tenantId]);});
  const authorized=await activateConnection(app,{tenantId,principalId,connectorType:'postgres'});await activateConnection(app,{tenantId,principalId,connectorType:'postgres'});
  await withTenant(migrate,tenantId,async(db)=>db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)",[tenantId,principalId,authorized.connectionId]));
  const server=await buildServer({pool:app,sessionSecret:'s'.repeat(64),goldenAccounts:[{tenantId,email:`${tenantId}@synthetic.example`}]});
  try{const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email:`${tenantId}@synthetic.example`,password:'synthetic-password'}});const result=await server.inject({method:'GET',url:'/api/analytic/sources',headers:{cookie:String(login.headers['set-cookie'])}});expect(result.statusCode).toBe(200);expect(result.json().sources).toEqual([{id:authorized.connectionId,type:'postgres'}]);}finally{await server.close();}
 });
});

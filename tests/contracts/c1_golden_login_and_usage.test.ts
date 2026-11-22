import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL'|'DATABASE_URL_MIGRATE') {
  const value=process.env[key]; if(!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url=new URL(value);url.pathname='/si_test';return url.toString();
}
const appPool=new Pool({connectionString:testUrl('DATABASE_URL'),max:2});
const migrate=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE'),max:1});
const tenant='golden-tenant-north';
let server: Awaited<ReturnType<typeof buildServer>>;
describe('phase 0 login and Usage',()=>{
 beforeAll(async()=>{
  await withTenant(migrate,tenant,async(db)=>{
   await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$2)',[tenant,'Meridian North Synthetic']);
   await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)',[tenant,'analyst@north.example',hashPassword('golden-local-only')]);
  });
  server=await buildServer({pool:appPool,sessionSecret:'s'.repeat(64),goldenAccounts:[{tenantId:tenant,email:'analyst@north.example'}]});
 });
 afterAll(async()=>{await server.close();await appPool.end();await migrate.end();});
 it('c1_golden_user_login_creates_revocable_tenant_session_and_usage_route',async()=>{
  const login=await server.inject({method:'POST',url:'/api/auth/login',payload:{email:'analyst@north.example',password:'golden-local-only'}});
  expect(login.statusCode).toBe(200);
  const cookie=login.headers['set-cookie'];expect(cookie).toContain('si_session=');
  const usage=await server.inject({method:'GET',url:'/api/usage',headers:{cookie:cookie.split(';')[0]}});
  expect(usage.statusCode).toBe(200);expect(usage.json().tenant_id).toBe(tenant);
  const logout=await server.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:cookie.split(';')[0]}});
  expect(logout.statusCode).toBe(204);
  expect((await server.inject({method:'GET',url:'/api/usage',headers:{cookie:cookie.split(';')[0]}})).statusCode).toBe(401);
 });
});

import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import golden from '../tests/golden/phase0.json' with { type:'json' };
import phase3E2e from '../tests/golden/phase3-e2e.json' with { type:'json' };
import { hashPassword } from '../apps/api/src/server.js';

config({path:'.env'});
const password='golden-local-only';
const migrateUrl=new URL(process.env.DATABASE_URL_MIGRATE??'');
if(process.argv.includes('--test'))migrateUrl.pathname='/si_test';
const pool=new Pool({connectionString:migrateUrl.toString()});
try{
 for(const tenant of [...golden.tenants,...phase3E2e.tenants]){
  await withTenant(pool,tenant.id,async(client)=>client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET name=EXCLUDED.name',[tenant.id,tenant.name]));
 }
 for(const user of [...golden.users,...phase3E2e.users]){
  await withTenant(pool,user.tenantId,async(client)=>client.query(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)
    ON CONFLICT(tenant_id,email) DO UPDATE SET password_hash=EXCLUDED.password_hash`,[user.tenantId,user.email,hashPassword(password,user.id)]));
 }
 console.log(`Seeded ${golden.tenants.length+phase3E2e.tenants.length} synthetic tenants and ${golden.users.length+phase3E2e.users.length} synthetic users.`);
}catch(error){console.error('Golden seed failed; confirm migrations have run and DATABASE_URL_MIGRATE points to the Scale Insyght database.');throw error;}finally{await pool.end();}

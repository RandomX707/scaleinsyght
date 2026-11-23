import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import golden from '../tests/golden/phase0.json' with { type:'json' };
import phase3E2e from '../tests/golden/phase3-e2e.json' with { type:'json' };
import phase4 from '../tests/golden/phase4.json' with { type:'json' };
import { hashPassword } from '../apps/api/src/server.js';

config({path:'.env'});
const password='golden-local-only';
const migrateUrl=new URL(process.env.DATABASE_URL_MIGRATE??'');
if(process.argv.includes('--test'))migrateUrl.pathname='/si_test';
const pool=new Pool({connectionString:migrateUrl.toString()});
try{
 for(const tenant of [...golden.tenants,...phase3E2e.tenants,phase4.tenant]){
  await withTenant(pool,tenant.id,async(client)=>client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET name=EXCLUDED.name',[tenant.id,tenant.name]));
 }
 for(const user of [...golden.users,...phase3E2e.users]){
  await withTenant(pool,user.tenantId,async(client)=>client.query(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)
    ON CONFLICT(tenant_id,email) DO UPDATE SET password_hash=EXCLUDED.password_hash`,[user.tenantId,user.email,hashPassword(password,user.id)]));
 }
 await withTenant(pool,phase4.tenant.id,async(client)=>{
  for(const adapter of phase4.adapters){
   await client.query(`INSERT INTO hub.adapters(tenant_id,product,connected,current_version) VALUES($1,$2,$3,$4)
    ON CONFLICT(tenant_id,product) DO UPDATE SET connected=EXCLUDED.connected,current_version=EXCLUDED.current_version,updated_at=clock_timestamp()`,[phase4.tenant.id,adapter.product,adapter.connected,adapter.version]);
   await client.query(`INSERT INTO hub.adapter_versions(tenant_id,product,version,fixture_key,capabilities) VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(tenant_id,product,version) DO NOTHING`,[phase4.tenant.id,adapter.product,adapter.version,adapter.fixtureKey,JSON.stringify(adapter.capabilities)]);
  }
  for(const metric of phase4.metrics){
   const semantics=phase4.adapters.find((adapter)=>adapter.product==='semantics');
   if(!semantics)throw new Error('phase4_semantics_adapter_missing');
   await client.query(`INSERT INTO hub.certified_metrics(tenant_id,metric_id,adapter_product,adapter_version,name,description,dimensions,unit,certified,fixture_key,source_asset)
    VALUES($1,$2,'semantics',$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
    ON CONFLICT(tenant_id,metric_id) DO UPDATE SET adapter_version=EXCLUDED.adapter_version,name=EXCLUDED.name,description=EXCLUDED.description,dimensions=EXCLUDED.dimensions,unit=EXCLUDED.unit,certified=EXCLUDED.certified,fixture_key=EXCLUDED.fixture_key,source_asset=EXCLUDED.source_asset`,
    [phase4.tenant.id,metric.id,semantics.version,metric.name,metric.description,JSON.stringify(metric.dimensions),metric.unit,metric.certified,metric.fixtureKey,metric.sourceAsset]);
  }
 });
 console.log(`Seeded ${golden.tenants.length+phase3E2e.tenants.length+1} synthetic tenants and ${golden.users.length+phase3E2e.users.length} synthetic users.`);
}catch(error){console.error('Golden seed failed; confirm migrations have run and DATABASE_URL_MIGRATE points to the Scale Insyght database.');throw error;}finally{await pool.end();}

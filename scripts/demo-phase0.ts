import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { createRun,addRunSteps,transitionRun } from '@scaleinsyght/runner';
import { activateConnection,registerCapability } from '@scaleinsyght/registry';

config({path:fileURLToPath(new URL('../.env',import.meta.url))});
const golden=JSON.parse(readFileSync(new URL('../tests/golden/phase0.json',import.meta.url),'utf8')) as {tenants:Array<{id:string;name:string}>;users:Array<{tenantId:string;email:string}>};
const app=new Pool({connectionString:process.env.DATABASE_URL});const migrate=new Pool({connectionString:process.env.DATABASE_URL_MIGRATE});
try{
 for(const user of golden.users){
  const principalId=await withTenant(app,user.tenantId,async(client)=>{
   const result=await client.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1 AND email=$2 AND is_active',[user.tenantId,user.email]);
   if(!result.rowCount)throw new Error(`Golden account ${user.email} is not seeded; run pnpm db:seed:golden`);
   return result.rows[0]!.user_id;
  });
  const hasCapability=await withTenant(app,user.tenantId,async(client)=>client.query('SELECT 1 FROM registry.capabilities WHERE capability_id=$1',['golden.read']));
  if(!hasCapability.rowCount)await registerCapability(app,user.tenantId,{capabilityId:'golden.read',version:1,effectClass:'READ',effectSafety:'not_applicable',enabled:true,inputSchema:{type:'object'},outputSchema:{type:'object'}});
  const connection=await activateConnection(app,{tenantId:user.tenantId,principalId,connectorType:'postgres'});
  const run=await createRun(migrate,{tenantId:user.tenantId,principalId});
  const scriptedSteps=['read_metadata_summary','read_metadata_count'];
  for(const to of ['PLANNING','PLAN_VALIDATED','RUNNING'] as const)await transitionRun(migrate,{tenantId:user.tenantId,runId:run.runId,to});
  await addRunSteps(migrate,{tenantId:user.tenantId,runId:run.runId,steps:scriptedSteps.map((_,index)=>({capabilityId:'golden.read',capabilityVersion:1,agentId:connection.agentId,stepOrder:index+1,sourceGroupId:connection.sourceGroupId,sourceGroupVersion:connection.sourceGroupVersion}))});
  const tenantName=golden.tenants.find(tenant=>tenant.id===user.tenantId)?.name??user.tenantId;
  console.log(`Started two-step synthetic read-only run for ${tenantName}: ${run.runId}`);
 }
 console.log('The native worker consumes these jobs and records only golden result references.');
}catch(error){console.error('Phase 0 demo failed. Confirm migrations and golden seed are ready in the Scale Insyght development database.');throw error;}finally{await app.end();await migrate.end();}

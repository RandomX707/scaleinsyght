import{afterAll,describe,expect,it}from'vitest';
import{config}from'dotenv';
import{Pool}from'pg';
import{withTenant}from'@scaleinsyght/db';
import{activateConnection,moveConnectionToGroup,savePersonalMemory,readPersonalMemory}from'@scaleinsyght/registry';
import{createRun,addRunStep,claimNextStep,completeStep,transitionRun}from'@scaleinsyght/runner';
config({path:'.env'});
function testUrl(key:'DATABASE_URL'|'DATABASE_URL_WORKER'|'DATABASE_URL_MIGRATE'){const value=process.env[key];if(!value)throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);const url=new URL(value);url.pathname='/si_test';return url.toString();}
const app=new Pool({connectionString:testUrl('DATABASE_URL')});const worker=new Pool({connectionString:testUrl('DATABASE_URL_WORKER')});const migrate=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});
describe('contract 2 source groups and personal memory',()=>{
 afterAll(async()=>{await app.end();await worker.end();await migrate.end();});
 it('c2_source_group_move_versions_without_changing_pinned_run',async()=>{
  const tenant=`group-${crypto.randomUUID()}`;let principal='';
  await withTenant(migrate,tenant,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenant]);principal=(await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[tenant,`${tenant}@synthetic.example`])).rows[0]!.user_id;});
  const first=await activateConnection(app,{tenantId:tenant,principalId:principal,connectorType:'postgres'});
  const second=await activateConnection(app,{tenantId:tenant,principalId:principal,connectorType:'snowflake'});
  const run=await createRun(migrate,{tenantId:tenant,principalId:principal});
  for(const to of ['PLANNING','PLAN_VALIDATED','RUNNING'] as const)await transitionRun(migrate,{tenantId:tenant,runId:run.runId,to});
  await addRunStep(migrate,{tenantId:tenant,runId:run.runId,capabilityId:'golden.read',capabilityVersion:1,agentId:second.agentId,stepOrder:1,sourceGroupId:second.sourceGroupId,sourceGroupVersion:second.sourceGroupVersion});
  await moveConnectionToGroup(app,{tenantId:tenant,connectionId:second.connectionId,targetGroupId:first.sourceGroupId,actor:'person'});
  const versions=await withTenant(migrate,tenant,async(db)=>db.query<{source_group_id:string;source_group_version:number}>('SELECT source_group_id,source_group_version FROM runs.steps WHERE run_id=$1',[run.runId]));
  expect(versions.rows[0]).toEqual({source_group_id:second.sourceGroupId,source_group_version:1});
  const current=await withTenant(migrate,tenant,async(db)=>db.query<{source_group_id:string;source_group_version:number}>('SELECT source_group_id,source_group_version FROM registry.connections WHERE connection_id=$1',[second.connectionId]));
  expect(current.rows[0]).toEqual({source_group_id:first.sourceGroupId,source_group_version:2});
  expect(first.agentId).not.toBe(second.agentId);
  const claim=await claimNextStep(worker,'group-pin-worker',60_000);
  expect(claim?.runId).toBe(run.runId);
  await completeStep(worker,claim!,{resultRef:'golden://phase0/summary'});
 });
 it('c2_personal_agent_memory_isolation_and_safe_storage',async()=>{
  const tenant=`memory-${crypto.randomUUID()}`;let personA='';let personB='';
  await withTenant(migrate,tenant,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenant]);personA=(await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[tenant,`${tenant}-a@synthetic.example`])).rows[0]!.user_id;personB=(await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[tenant,`${tenant}-b@synthetic.example`])).rows[0]!.user_id;});
  await savePersonalMemory(app,{tenantId:tenant,personId:personA,memory:{roleTemplate:'analyst',vocabulary:{turnover:'net revenue'},defaultSources:[],savedPlanIds:[],answerStyle:'concise'}});
  expect((await readPersonalMemory(app,{tenantId:tenant,personId:personB})).roleTemplate).toBeNull();
  const stored=await readPersonalMemory(app,{tenantId:tenant,personId:personA});
  expect(stored.vocabulary).toEqual({turnover:'net revenue'});
  expect(JSON.stringify(stored)).not.toMatch(/result_rows|identifier_values|raw_id/i);
 });
});

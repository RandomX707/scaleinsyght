import { config } from 'dotenv';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { withRunTenant } from '@scaleinsyght/db';
import { claimNextStep, completeStep, failStep } from '@scaleinsyght/runner';
import { finalizeAnalyticRun } from '@scaleinsyght/analytic';
import { executeGoldenStep } from './test-analytic-executor.js';
import type { AnalyticPlan } from '@scaleinsyght/contracts';
import { authorise } from '@scaleinsyght/policy';
import { claimDueSchedule, markScheduleSlotSkipped, markScheduleSlotStarted, persistReportSnapshot, startScheduledReportRun } from '@scaleinsyght/reports';

config({path:fileURLToPath(new URL('../../.env',import.meta.url))});
const golden=JSON.parse(readFileSync(new URL('../golden/phase0.json',import.meta.url),'utf8')) as {scriptedRun:{resultRefs:string[]}};
const pool=new Pool({connectionString:process.env.DATABASE_URL_WORKER});
const workerId=`worker-${process.pid}`;
const healthServer=createServer((request,response)=>{if(request.url==='/health'){response.writeHead(200,{'content-type':'application/json'});response.end('{"status":"ok"}');return;}response.writeHead(404);response.end();});
await new Promise<void>((resolve,reject)=>{healthServer.once('error',reject);healthServer.listen(Number(process.env.WORKER_HEALTH_PORT??3001),process.env.WORKER_HEALTH_HOST??'127.0.0.1',resolve);});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;});
async function dispatchDueSchedule():Promise<boolean>{
 const due=await claimDueSchedule(pool);if(!due)return false;
 try{await startScheduledReportRun(pool,due);await markScheduleSlotStarted(pool,due);}
 catch(error){const reason=error instanceof Error?error.message:'';if(['governed_version_not_approved','governed_version_not_found','source_not_active','source_group_version_not_pinned','capability_not_available','principal_not_entitled'].includes(reason)){await markScheduleSlotSkipped(pool,due,reason as 'governed_version_not_approved'|'governed_version_not_found'|'source_not_active'|'source_group_version_not_pinned'|'capability_not_available'|'principal_not_entitled');console.info(`Scheduled report slot skipped for schedule ${due.scheduleId}: ${reason}`);}else console.error(`Scheduled report dispatch failed for schedule ${due.scheduleId}:`,error);}
 return true;
}
while(!stopping){
 try{
  const claim=await claimNextStep(pool,workerId,30_000);
  if(!claim){if(await dispatchDueSchedule())continue;await new Promise(resolve=>setTimeout(resolve,500));continue;}
  const task=await withRunTenant(pool,claim.runId,async(client)=>{
   const result=await client.query<{step_order:number;source_group_id:string|null;plan:AnalyticPlan|null;principal_id:string}>(
    `SELECT s.step_order,s.source_group_id,p.plan,r.principal_id FROM runs.steps s JOIN runs.runs r USING(tenant_id,run_id) LEFT JOIN runs.analytic_plans p USING(tenant_id,run_id)
     WHERE s.run_id=$1 AND s.step_id=$2`,[claim.runId,claim.stepId]);
   const row=result.rows[0];if(!row)return null;
   if(!row.plan)return{order:row.step_order,plan:null as null};
   const planStep=row.plan.steps[row.step_order-1];
   if(!planStep||planStep.step_id!==claim.stepId)return null;
   const source=await client.query<{connector_type:string}>('SELECT connector_type FROM registry.connections WHERE tenant_id=current_setting(\'app.tenant_id\') AND connection_id=$1',[planStep.source_id]);
   if(!source.rowCount||!row.source_group_id)return null;
   return{order:row.step_order,plan:row.plan,step:planStep,connectorType:source.rows[0]!.connector_type,groupId:row.source_group_id,principalId:row.principal_id};
  });
  if(!task)throw new Error('worker_task_missing');
  if(task.plan){
   try{
    const plan=task.plan;const step=plan.steps[task.order-1];
    if(!step||step.step_id!==claim.stepId)throw new Error('worker_plan_step_mismatch');
    const decision=await authorise(pool,{principal:{tenant_id:claim.tenantId,principal_id:task.principalId,kind:'user',roles:[],groups:[],attributes:{}},capability_id:step.capability_id,resources:[step.source_id],purpose:'analytic_query',environment:'synthetic_golden'},claim.runId);
    if(decision.outcome!=='allow')throw new Error('policy_revoked');
    const result=await executeGoldenStep({step,question:plan.question,connectorType:task.connectorType,groupId:task.groupId,timeoutMs:step.timeout_s*1000});
    await completeStep(pool,claim,{resultRef:`golden://analytic/${claim.runId}/${claim.stepId}`,analyticResult:result});
   }catch(error){
    const reason=error instanceof Error&&error.message==='synthetic_timeout'?'source_timeout':error instanceof Error&&error.message==='policy_revoked'?'authorization_revoked':'golden_execution_failed';
    await failStep(pool,claim,{reasonCode:reason});
   }
   await finalizeAnalyticRun(pool,claim.runId);
   await persistReportSnapshot(pool,claim.runId);
  }else{
   const ref=golden.scriptedRun.resultRefs[task.order-1];
   if(!ref)throw new Error(`No synthetic golden result reference for step order ${task.order}`);
   await completeStep(pool,claim,{resultRef:ref});
  }
 }catch(error){console.error('Worker iteration failed:',error);process.exitCode=1;stopping=true;}
}
healthServer.close();await pool.end();

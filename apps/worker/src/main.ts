import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { withRunTenant } from '@scaleinsyght/db';
import { claimNextStep, completeStep, failStep } from '@scaleinsyght/runner';
import { finalizeAnalyticRun } from '@scaleinsyght/analytic';
import type { AnalyticPlan } from '@scaleinsyght/contracts';
import { createPostgresConnector, createSqlServerConnector, decryptConnectionSecret, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { OpenAIModelGateway } from '@scaleinsyght/model-gateway';
import { authorise } from '@scaleinsyght/policy';
import { claimDueSchedule, markScheduleSlotSkipped, markScheduleSlotStarted, persistReportSnapshot, startScheduledReportRun } from '@scaleinsyght/reports';

config({path:fileURLToPath(new URL('../../../.env',import.meta.url))});
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
    const result=await client.query<{step_order:number;source_group_id:string|null;plan:AnalyticPlan|null;principal_id:string;connector_type:string;display_name:string;ciphertext:Buffer|null;nonce:Buffer|null;auth_tag:Buffer|null}>(
    `SELECT s.step_order,s.source_group_id,p.plan,r.principal_id,c.connector_type,c.display_name,secret.ciphertext,secret.nonce,secret.auth_tag FROM runs.steps s JOIN runs.runs r USING(tenant_id,run_id) LEFT JOIN runs.analytic_plans p USING(tenant_id,run_id)
     LEFT JOIN registry.connections c ON c.tenant_id=r.tenant_id AND c.connection_id=(p.plan->'steps'->(s.step_order-1)->>'source_id')::uuid
     LEFT JOIN LATERAL(SELECT ciphertext,nonce,auth_tag FROM registry.connection_secrets WHERE tenant_id=c.tenant_id AND connection_id=c.connection_id ORDER BY secret_version DESC LIMIT 1) secret ON true
     WHERE s.run_id=$1 AND s.step_id=$2`,[claim.runId,claim.stepId]);
   const row=result.rows[0];if(!row)return null;
   if(!row.plan)return{order:row.step_order,plan:null as null};
   const planStep=row.plan.steps[row.step_order-1];
   if(!planStep||planStep.step_id!==claim.stepId)return null;
   if(!row.connector_type||!row.source_group_id)return null;
   return{order:row.step_order,plan:row.plan,step:planStep,connectorType:row.connector_type,displayName:row.display_name,ciphertext:row.ciphertext,nonce:row.nonce,authTag:row.auth_tag,groupId:row.source_group_id,principalId:row.principal_id};
  });
  if(!task)throw new Error('worker_task_missing');
  if(task.plan){
   try{
    const plan=task.plan;const step=plan.steps[task.order-1];
    if(!step||step.step_id!==claim.stepId)throw new Error('worker_plan_step_mismatch');
    const decision=await authorise(pool,{principal:{tenant_id:claim.tenantId,principal_id:task.principalId,kind:'user',roles:[],groups:[],attributes:{}},capability_id:step.capability_id,resources:[step.source_id],purpose:'analytic_query',environment:'production'},claim.runId);
    if(decision.outcome!=='allow')throw new Error('policy_revoked');
    const intent=step.inputs.query_intent;
    if(!intent||!['postgres','sql_server'].includes(task.connectorType)||!task.ciphertext||!task.nonce||!task.authTag||!process.env.CONNECTION_SECRET_KEY)throw new Error('source_query_executor_unavailable');
    const secret=decryptConnectionSecret<Record<string,unknown>>({version:1,ciphertext:task.ciphertext.toString('base64'),nonce:task.nonce.toString('base64'),authTag:task.authTag.toString('base64')});
    let connector: ReadOnlyConnector;
    if(task.connectorType==='sql_server')connector=createSqlServerConnector({server:String(secret.host),port:Number(secret.port),database:String(secret.database),username:String(secret.username),password:String(secret.password),encrypt:true,trustServerCertificate:secret.trustServerCertificate===true,id:step.source_id,name:task.displayName||'SQL Server source',statementTimeoutMs:10_000,maxRows:1_000});
    else{const sourceUrl=new URL('postgresql://placeholder');sourceUrl.hostname=String(secret.host);sourceUrl.port=String(secret.port);sourceUrl.username=String(secret.username);sourceUrl.password=String(secret.password);sourceUrl.pathname=`/${String(secret.database)}`;sourceUrl.searchParams.set('sslmode',String(secret.sslMode));connector=createPostgresConnector({connectionString:sourceUrl.toString(),id:step.source_id,name:task.displayName||'PostgreSQL source',statementTimeoutMs:10_000,maxRows:1_000});}
    try{
      await connector.test();await connector.discover({mode:'profile'});
      const executed=await connector.executeQueryIntent?.(intent);if(!executed)throw new Error('source_query_executor_unavailable');
      if(!executed.rows.length||executed.rows.length>100||executed.rows.some(row=>!row||typeof row!=='object'||!('value'in row)||!Number.isFinite(Number(row.value))))throw new Error('analytic_query_result_shape_invalid');
      const rows=executed.rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='group_key')));const value=Number(rows[0]!.value);if(!Number.isFinite(value))throw new Error('analytic_query_result_shape_invalid');
      const evidenceId=randomUUID();const queryIntent=intent as Record<string,unknown>;const assetNames=[queryIntent.table,queryIntent.leftTable,queryIntent.rightTable].filter((name):name is string=>typeof name==='string');
      const assets=await withRunTenant(pool,claim.runId,client=>client.query<{asset_id:string}>('SELECT asset_id FROM graph.assets WHERE tenant_id=current_setting(\'app.tenant_id\') AND source_id=$1 AND asset_type=\'dataset\' AND qualified_name=ANY($2::text[])',[step.source_id,assetNames]));
      const answer=await new OpenAIModelGateway(pool).complete({tenantId:claim.tenantId,alias:'default',question:`Write one concise answer sentence to the user's exact question from these aggregate query results only. Never guess or add facts. If the results do not answer the question, say so. User question: ${plan.question} Aggregate rows: ${JSON.stringify(rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='group_key'))))}`,metadata:{classification:'METADATA_STATISTICAL',structural:{source:task.displayName||'Data source',query:executed.sql},descriptive:{},statistical:{aggregate_value:value,group_count:rows.length},sensitivityTags:[],groupSize:100,minimumCellSize:5},maxOutputTokens:180});
      const modelText=answer.text.trim().replace(/[\r\n]+/g,' ').slice(0,600);const numericValues=modelText.match(/\d+(?:,\d{3})*(?:\.\d+)?/g)?.map(token=>Number(token.replaceAll(',','')))??[];const allowedNumbers=new Set([...rows.flatMap(row=>Object.entries(row).filter(([key])=>key==='value').map(([,item])=>Number(item))),rows.length]);if(!modelText||numericValues.some(number=>!allowedNumbers.has(number)))throw new Error('model_answer_validation_failed');const statement=modelText;
      await withRunTenant(pool,claim.runId,client=>client.query('INSERT INTO runs.model_provenance(tenant_id,run_id,call_purpose,model_name,input_tokens,output_tokens) VALUES(current_setting(\'app.tenant_id\'),$1,\'answer\',$2,$3,$4)',[claim.runId,answer.model,answer.inputTokens,answer.outputTokens]));
      const analyticResult={sourceId:step.source_id,connectorType:task.connectorType,groupId:task.groupId,metric:String((intent as {kind?:unknown}).kind??'query'),value,rows:rows.length===1&&!('group_value'in rows[0]!)?undefined:rows,claims:[{claim_id:randomUUID(),kind:'metric',statement,evidence_ids:[evidenceId]}],evidence:[{evidence_id:evidenceId,kind:'query',source_id:step.source_id,asset_ids:assets.rows.map(item=>item.asset_id),locator:`${task.displayName||'Data source'} · ${executed.sql}`,content_hash:createHash('sha256').update(executed.sql).digest('hex'),captured_at:new Date().toISOString(),collector_version:`${task.connectorType}-query-v1`,redacted_summary:`Executed on ${task.displayName||'Data source'}; returned ${executed.rows.length} aggregate row(s).`}]};
      if(!await completeStep(pool,claim,{resultRef:`postgres-query:${evidenceId}`,analyticResult}))throw new Error('worker_fence_lost');
    }finally{await connector.close?.();}
   }catch(error){
    const reason=error instanceof Error&&error.message==='source_timeout'?'source_timeout':error instanceof Error&&error.message==='policy_revoked'?'authorization_revoked':'source_query_executor_unavailable';
    await failStep(pool,claim,{reasonCode:reason});
   }
   await finalizeAnalyticRun(pool,claim.runId);
   await persistReportSnapshot(pool,claim.runId);
  }else{
   await failStep(pool,claim,{reasonCode:'source_query_executor_unavailable'});
  }
 }catch(error){console.error('Worker iteration failed:',error);process.exitCode=1;stopping=true;}
}
healthServer.close();await pool.end();

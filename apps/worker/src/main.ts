import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { withRunTenant } from '@scaleinsyght/db';
import { claimNextStep, completeStep, failStep, type StepClaim } from '@scaleinsyght/runner';
import { planLiveQuestion, type PlanningSource } from '@scaleinsyght/api/live-planner';
import { createAnalyticPlan, startAnalyticRun, MINIMUM_ANALYTIC_CELL_SIZE, finalizeAnalyticRun, roundForModel, summarizeGroups } from '@scaleinsyght/analytic';
import type { AnalyticPlan } from '@scaleinsyght/contracts';
import { createExcelConnector, createPostgresConnector, createSqlServerConnector, decryptConnectionSecret, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { resolve as resolvePath } from 'node:path';
import { OpenAIModelGateway } from '@scaleinsyght/model-gateway';
import { authorise } from '@scaleinsyght/policy';
import { claimDueSchedule, markScheduleSlotSkipped, markScheduleSlotStarted, persistReportSnapshot, startScheduledReportRun } from '@scaleinsyght/reports';

config({path:fileURLToPath(new URL('../../../.env',import.meta.url))});
const pool=new Pool({connectionString:process.env.DATABASE_URL_WORKER});
const artifactStore=process.env.ARTIFACT_MASTER_KEY?new EncryptedArtifactStore(resolvePath(process.env.ARTIFACT_VOLUME_PATH??'.local/artifacts'),Buffer.from(process.env.ARTIFACT_MASTER_KEY,'base64')):null;
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
async function processPlanning(claim: StepClaim): Promise<boolean> {
  const request = await withRunTenant(pool, claim.runId, async client => (await client.query<{
    principal_id:string;conversation_id:string;question:string;sources:PlanningSource[];
    context:Array<{role:'user'|'assistant';content:string}>;
  }>(`SELECT r.principal_id,r.conversation_id,p.question,p.sources,p.context
      FROM runs.planning_requests p JOIN runs.runs r USING(tenant_id,run_id) JOIN runs.steps s USING(tenant_id,run_id)
      WHERE p.run_id=$1 AND s.step_id=$2 AND s.step_order=0`,[claim.runId,claim.stepId])).rows[0]);
  if (!request) return false;
  let reason = 'analytic_planning_failed';
  let attempts: Array<{model:string;inputTokens:number;outputTokens:number;error?:string}> = [];
  let options: unknown;
  try {
    const allowed = await withRunTenant(pool,claim.runId,async client => (await client.query(
      `SELECT c.connection_id FROM registry.connections c
       WHERE c.tenant_id=$1 AND c.status='active' AND c.connection_id=ANY($2::uuid[])
       AND EXISTS (SELECT 1 FROM core.entitlements e WHERE e.tenant_id=c.tenant_id AND e.principal_id=$3
         AND e.capability_id='analytic.read' AND e.allowed AND (e.resource_id IS NULL OR e.resource_id=c.connection_id::text))`,
      [claim.tenantId,request.sources.map(source=>source.source_id),request.principal_id])).rowCount);
    if (allowed !== request.sources.length) throw new Error('principal_not_entitled');
    const planned = await planLiveQuestion(pool,claim.tenantId,request.question,request.sources,request.context,request.principal_id);
    if (planned.kind === 'planned') {
      attempts = planned.provenance.typedPlan.attempts;
      const plan = await createAnalyticPlan({runId:claim.runId,question:request.question,queryIntents:planned.intents,
        sources:planned.selected.map(source=>({sourceId:source.source_id,agentId:source.agent_id,groupId:source.group_id,groupVersion:source.group_version}))});
      await startAnalyticRun(pool,{tenantId:claim.tenantId,principalId:request.principal_id,conversationId:request.conversation_id,
        plan,planningClaim:claim,plannerProvenance:planned.provenance});
      return true;
    }
    attempts = planned.attempts;
    reason = planned.kind === 'choice' ? 'analytic_source_choice_required' : planned.reason;
    if (planned.kind === 'choice') options = planned.options;
  } catch (error) {
    if (error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message)) reason = error.message;
  }
  await withRunTenant(pool,claim.runId,async client=>{
    const failed=await client.query(`UPDATE runs.steps SET state='FAILED',lease_owner=NULL,lease_expires_at=NULL
      WHERE run_id=$1 AND step_id=$2 AND fencing_token=$3 AND lease_owner=$4 AND lease_expires_at>clock_timestamp()`,
      [claim.runId,claim.stepId,claim.fencingToken,claim.workerId]);
    if (!failed.rowCount) return;
    const run=await client.query<{state_version:number}>(`UPDATE runs.runs SET state='FAILED',state_version=state_version+1
      WHERE run_id=$1 AND state='PLANNING' RETURNING state_version`,[claim.runId]);
    if (!run.rowCount) throw new Error('planning_state_changed');
    for (const attempt of attempts) await client.query(
      `INSERT INTO runs.model_provenance(tenant_id,run_id,call_purpose,model_name,input_tokens,output_tokens,typed_plan)
       VALUES($1,$2,'plan',$3,$4,$5,$6::jsonb)`,[claim.tenantId,claim.runId,attempt.model,attempt.inputTokens,attempt.outputTokens,JSON.stringify({error:attempt.error??reason})]);
    const latest=await client.query(`SELECT coalesce(max(sequence),0) AS last FROM runs.events WHERE run_id=$1`,[claim.runId]);
    const sequence=Number(latest.rows[0]!.last);
    await client.query(`INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,step_id,fencing_token,safe_payload)
      VALUES($1,$2,$3,'step_failed',$4,$5,$6::jsonb),($1,$2,$7,'run_terminal',NULL,NULL,$8::jsonb)`,
      [claim.tenantId,claim.runId,sequence+1,claim.stepId,claim.fencingToken,
        JSON.stringify({step_id:claim.stepId,attempt:claim.attempt,fencing_token:claim.fencingToken,reason_codes:[reason]}),sequence+2,
        JSON.stringify({state:'FAILED',state_version:run.rows[0]!.state_version,reason,...(options?{options}:{})})]);
  });
  return true;
}
while(!stopping){
 try{
  const claim=await claimNextStep(pool,workerId,120_000);
  if(!claim){if(await dispatchDueSchedule())continue;await new Promise(resolve=>setTimeout(resolve,500));continue;}
  if(await processPlanning(claim))continue;
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
    if(!intent||!['postgres','sql_server','excel'].includes(task.connectorType))throw new Error('source_query_executor_unavailable');
    let connector: ReadOnlyConnector;
    if(task.connectorType==='excel'){
     // The workbook is decrypted for this step only and queried in an in-memory DuckDB copy that close() discards.
     if(!artifactStore)throw new Error('source_query_executor_unavailable');
     const stored=await withRunTenant(pool,claim.runId,client=>client.query<{artifact_id:string;key_salt:Buffer}>("SELECT w.artifact_id,w.key_salt FROM artifacts.workbooks w JOIN registry.connections c ON c.tenant_id=w.tenant_id AND c.connection_id=w.connection_id WHERE w.tenant_id=current_setting('app.tenant_id') AND w.connection_id=$1 AND c.status='active' ORDER BY w.created_at DESC LIMIT 1",[step.source_id]));
     const artifact=stored.rows[0];if(!artifact)throw new Error('source_query_executor_unavailable');
     connector=createExcelConnector({id:step.source_id,name:task.displayName||'Workbook',workbook:await artifactStore.read(claim.tenantId,artifact.artifact_id,artifact.key_salt)});
    }else{
    if(!task.ciphertext||!task.nonce||!task.authTag||!process.env.CONNECTION_SECRET_KEY)throw new Error('source_query_executor_unavailable');
    const secret=decryptConnectionSecret<Record<string,unknown>>({version:1,ciphertext:task.ciphertext.toString('base64'),nonce:task.nonce.toString('base64'),authTag:task.authTag.toString('base64')});
    if(task.connectorType==='sql_server')connector=createSqlServerConnector({server:String(secret.host),port:Number(secret.port),database:String(secret.database),username:String(secret.username),password:String(secret.password),encrypt:true,trustServerCertificate:secret.trustServerCertificate===true,id:step.source_id,name:task.displayName||'SQL Server source',statementTimeoutMs:10_000,maxRows:1_000});
    else{const sourceUrl=new URL('postgresql://placeholder');sourceUrl.hostname=String(secret.host);sourceUrl.port=String(secret.port);sourceUrl.username=String(secret.username);sourceUrl.password=String(secret.password);sourceUrl.pathname=`/${String(secret.database)}`;sourceUrl.searchParams.set('sslmode',String(secret.sslMode));connector=createPostgresConnector({connectionString:sourceUrl.toString(),id:step.source_id,name:task.displayName||'PostgreSQL source',statementTimeoutMs:10_000,maxRows:1_000});}
    }
    try{
      await connector.test();await connector.discover({mode:'profile'});
      const resolvedIntent = structuredClone(intent) as Record<string, unknown>;
      const filters = resolvedIntent.kind === 'filtered_count' ? [resolvedIntent]
        : Array.isArray(resolvedIntent.filters) ? resolvedIntent.filters as Array<Record<string, unknown>> : [];
      let missingCategory: {column: string; values: string[]; sql: string} | undefined;
      for (const filter of filters) {
        if (!connector.categoryValues || typeof filter.value !== 'string' ||
            !['eq', 'neq'].includes(String(filter.operator)) || typeof filter.column !== 'string') continue;
        const table = filter === resolvedIntent ? resolvedIntent.table : filter.table === 'right' ? resolvedIntent.rightTable
          : filter.table === 'left' || filter.table === undefined ? resolvedIntent.leftTable : filter.table;
        if (typeof table !== 'string') continue;
        const field = await withRunTenant(pool, claim.runId, async client => (await client.query<{sensitivity_tags: string[]}>(
          `SELECT p.sensitivity_tags FROM graph.assets a JOIN profiler.field_profiles p USING (tenant_id,asset_id)
           WHERE a.source_id=$1 AND a.qualified_name=$2 AND a.asset_type='field' AND a.active
           ORDER BY p.profile_version DESC LIMIT 1`, [step.source_id, table + '.' + filter.column])).rows[0]);
        if (!field || field.sensitivity_tags.length) continue;
        const categories = await connector.categoryValues(table, filter.column);
        if (!categories) continue;
        const requested = filter.value.toLowerCase();
        const match = categories.values.find(value => value === filter.value) ??
          categories.values.find(value => value.toLowerCase() === requested);
        if (match !== undefined) {
          filter.value = match;
        } else if (categories.values.length <= 100) {
          missingCategory = {column: filter.column, values: categories.values, sql: categories.sql};
          break;
        } else {
          throw new Error('category_domain_exceeds_limit');
        }
      }
      const executed = missingCategory ? {sql: missingCategory.sql, rows: [{value: 0, cell_size: 0}]}
        : await connector.executeQueryIntent?.(resolvedIntent, true);
      if (!executed) throw new Error('source_query_executor_unavailable');
      if(!executed.rows.length||executed.rows.length>100||executed.rows.some(row=>!row||typeof row!=='object'||!('value'in row)||!Number.isFinite(Number(row.value))))throw new Error('analytic_query_result_shape_invalid');
      const rows=executed.rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='group_key'&&key!=='cell_size')));const value=Number(rows[0]!.value);if(!Number.isFinite(value))throw new Error('analytic_query_result_shape_invalid');
      const evidenceId=randomUUID();const queryIntent=intent as Record<string,unknown>;const assetNames=[queryIntent.table,queryIntent.leftTable,queryIntent.rightTable].filter((name):name is string=>typeof name==='string');
      const assets=await withRunTenant(pool,claim.runId,client=>client.query<{asset_id:string}>('SELECT asset_id FROM graph.assets WHERE tenant_id=current_setting(\'app.tenant_id\') AND source_id=$1 AND asset_type=\'dataset\' AND qualified_name=ANY($2::text[])',[step.source_id,assetNames]));
      const groupTable=typeof queryIntent.table==='string'?queryIntent.table:queryIntent.groupByTable==='left'?queryIntent.leftTable:queryIntent.rightTable;
      const labels=connector.columnLabels&&typeof groupTable==='string'?await connector.columnLabels(groupTable):{};
      const columnLabels=Object.fromEntries(Object.entries(labels).filter(([name,label])=>name!==label));
      const groupLabel=typeof queryIntent.groupBy==='string'?columnLabels[queryIntent.groupBy]:undefined;
      const analyticResult={sourceId:step.source_id,connectorType:task.connectorType,groupId:task.groupId,metric:String((intent as {kind?:unknown}).kind??'query'),value,...(groupLabel?{groupLabel}:{}),...(Object.keys(columnLabels).length?{columnLabels}:{}),rows:rows.length===1&&!('group_value'in rows[0]!)?undefined:rows,minimumCellSize:Math.min(...executed.rows.map(row=>Number(row.cell_size??0))),cellSizes:executed.rows.map(row=>Number(row.cell_size??0)),...(missingCategory ? {missingCategory: {column: missingCategory.column, values: missingCategory.values}} : {}),claims:[],evidence:[{evidence_id:evidenceId,kind:'query',source_id:step.source_id,asset_ids:assets.rows.map(item=>item.asset_id),locator:`${task.displayName||'Data source'} · ${executed.sql}`,content_hash:createHash('sha256').update(executed.sql).digest('hex'),captured_at:new Date().toISOString(),collector_version:`${task.connectorType}-query-v1`,redacted_summary:`Executed on ${task.displayName||'Data source'}; returned ${executed.rows.length} aggregate row(s).`}]};
      if(!await completeStep(pool,claim,{resultRef:`postgres-query:${evidenceId}`,analyticResult}))throw new Error('worker_fence_lost');
    }finally{await connector.close?.();}
   }catch(error){
    const reason=error instanceof Error&&error.message==='source_timeout'?'source_timeout':error instanceof Error&&error.message==='policy_revoked'?'authorization_revoked':'source_query_executor_unavailable';
    await failStep(pool,claim,{reasonCode:reason});
   }
   await finalizeAnalyticRun(pool,claim.runId,async ({plan,results})=>{
     const minimumCellSize = MINIMUM_ANALYTIC_CELL_SIZE;
     const rawValues=results.flatMap(result=>result.rows?.map(row=>Number(row.value))??[result.value]);
     const values=[...rawValues,...rawValues.map(roundForModel)];
     const summaryNumbers:number[]=[];
     const statistical=Object.fromEntries(results.flatMap((result,index)=>{
      const prefix=`source_${index+1}`;const summary=result.rows?summarizeGroups(result.rows):undefined;
      const summaryStats:Array<[string,number]>=summary?[[`${prefix}_group_count`,summary.groupCount],[`${prefix}_highest`,roundForModel(summary.highest.value)],[`${prefix}_lowest`,roundForModel(summary.lowest.value)],[`${prefix}_spread`,summary.spread],...summary.ties.flatMap((tie,tieIndex):Array<[string,number]>=>[[`${prefix}_tie_${tieIndex+1}_value`,tie.value],[`${prefix}_tie_${tieIndex+1}_group_count`,tie.labels.length]])]:[];
      summaryNumbers.push(...summaryStats.map(([,number])=>number));
      return [[`${prefix}_aggregate_count`,result.rows?.length??1],...(result.rows?.map((row,i)=>[`${prefix}_aggregate_${i+1}`,roundForModel(Number(row.value))])??[[`${prefix}_aggregate_1`,result.value]]),...summaryStats];
     })) as Record<string,number>;
     // Cross-source comparisons: the difference is computed here so the model never does arithmetic.
     if(results.length===2&&results.every(result=>!result.rows)){const difference=roundForModel(Math.abs(results[0]!.value-results[1]!.value));statistical.difference_between_sources=difference;summaryNumbers.push(difference);}
     const question=plan.question.toLowerCase();
     const mentionedYears=[...question.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match=>Number(match[0]));
     const sources=results.map(result=>{
      const intent=plan.steps.find(step=>step.source_id===result.sourceId)?.inputs.query_intent as Record<string,unknown>|undefined;
      const candidates=Array.isArray(intent?.filters)?intent.filters:intent?.kind==='filtered_count'?[intent]:[];
      const filters=candidates.map(({table,column,operator,value})=>{
       const rendered=typeof value==='string'?value:'';
       const rangeBoundary=/^\d{4}-01-01$/.test(rendered)&&mentionedYears.some(year=>Number(rendered.slice(0,4))===year||Number(rendered.slice(0,4))===year+1);
       const knownCategory=/^[a-z][a-z -]{0,63}$/i.test(rendered)&&question.includes(rendered.toLowerCase());
       return {table,column,operator,...(rangeBoundary?{calendar_boundary:rendered}:{}),...(knownCategory?{matches_category_in_question:true}:{})};
      });
      return {source:result.evidence[0]?.locator.split(' · ')[0],connector_type:result.connectorType,executed_query:result.evidence[0]?.locator.split(' · ').slice(1).join(' · '),filters,...(result.columnLabels?{column_labels:result.columnLabels}:{})};
     });
     const answer=await new OpenAIModelGateway(pool).complete({tenantId:claim.tenantId,principalId:task.principalId,alias:'default',question:`Write one concise answer to the exact user question using the disclosed aggregate statistics. Include a result value. Use each executed query and its disclosed filters to interpret its statistic. Group labels appear in the results table and chart below your sentence, so name no group labels. For grouped results, summarise them: give the highest and lowest values and the spread between them, using the disclosed highest, lowest and spread statistics. If difference_between_sources is disclosed you may state it. If tie statistics are disclosed, state each tie, for example '3 departments tie at 200', using the question's word for the groups. Source indexes match the statistics. When column_labels are given, refer to a column by its label, never by its SQL identifier. When there is more than one source, give each value next to its source name written exactly as in that source's source field. Do not invent facts. Question: ${plan.question}`,metadata:{classification:'METADATA_STATISTICAL',structural:{sources},descriptive:{},statistical,sensitivityTags:[],groupSize:Math.min(...results.map(result=>result.minimumCellSize===0?minimumCellSize:result.minimumCellSize??0)),minimumCellSize},maxOutputTokens:400});
     const statement=answer.text.trim().replace(/[\r\n]+/g,' ').slice(0,600);
     const numbers=(value:string)=>value.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/g)?.map(token=>Number(token.replaceAll(',','')))??[];
     const counts=results.map(result=>result.rows?.length??1);
     const allowed=new Set([...values,...counts,...summaryNumbers,...numbers(plan.question)]);
     if(!numbers(statement).some(number=>values.includes(number))||numbers(statement).some(number=>!allowed.has(number)))throw new Error('model_answer_validation_failed');
     const sourceNames=sources.map(source=>String(source.source??''));
     const attributed=results.length>1&&sourceNames.some(name=>name&&!statement.includes(name))&&results.every(result=>!result.rows)
      ?`${statement.replace(/[.\s]+$/,'')} (${results.map((result,index)=>`${sourceNames[index]}: ${result.value.toLocaleString('en-US')}`).join('; ')}).`
      :statement;
     return {statement:attributed,model:answer.model,inputTokens:answer.inputTokens,outputTokens:answer.outputTokens};
   });
   await persistReportSnapshot(pool,claim.runId);
  }else{
   await failStep(pool,claim,{reasonCode:'source_query_executor_unavailable'});
  }
 }catch(error){console.error('Worker iteration failed:',error);process.exitCode=1;stopping=true;}
}
healthServer.close();await pool.end();

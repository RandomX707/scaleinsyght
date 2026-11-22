import { randomUUID } from 'node:crypto';
import { canTransitionRun, type RunEvent, type RunState } from '@scaleinsyght/contracts';
import { withRunTenant, withTenant } from '@scaleinsyght/db';
import type { Pool, PoolClient } from 'pg';

export interface DurableRun { runId: string; }
export interface StepClaim { tenantId: string; runId: string; stepId: string; workerId: string; attempt: number; fencingToken: number; }

async function appendEvent(client: PoolClient, runId: string, type: string, payload: Record<string, unknown>, stepId?: string, fence?: number): Promise<void> {
  await client.query('SELECT run_id FROM runs.runs WHERE run_id = $1 FOR UPDATE', [runId]);
  const seq = await client.query<{ next: string }>('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM runs.events WHERE run_id=$1', [runId]);
  await client.query(
    `INSERT INTO runs.events(tenant_id,run_id,step_id,sequence,event_type,fencing_token,safe_payload)
     VALUES(current_setting('app.tenant_id'),$1,$2,$3,$4,$5,$6::jsonb)`,
    [runId, stepId ?? null, Number(seq.rows[0]!.next), type, fence ?? null, JSON.stringify(payload)],
  );
}

export async function createRun(pool: Pool, input: { tenantId: string; principalId: string; parentRunId?: string }): Promise<DurableRun> {
  const runId = randomUUID();
  await withTenant(pool, input.tenantId, async (client) => {
    await client.query(`INSERT INTO runs.runs(tenant_id,run_id,principal_id,parent_run_id,state) VALUES($1,$2,$3,$4,'CREATED')`, [input.tenantId,runId,input.principalId,input.parentRunId ?? null]);
    await appendEvent(client,runId,input.parentRunId ? 'child_run_created' : 'run_created', input.parentRunId ? { parent_run_id: input.parentRunId, child_run_id: runId } : { state:'CREATED', state_version:0 });
  });
  return { runId };
}

export async function addRunStep(pool: Pool, input: {tenantId:string;runId:string;capabilityId:string;capabilityVersion:number;agentId:string;stepOrder:number;sourceGroupId?:string;sourceGroupVersion?:number}): Promise<string> {
  return (await addRunSteps(pool,{tenantId:input.tenantId,runId:input.runId,steps:[input]}))[0]!;
}

export async function addRunSteps(pool:Pool,input:{tenantId:string;runId:string;steps:Array<{capabilityId:string;capabilityVersion:number;agentId:string;stepOrder:number;sourceGroupId?:string;sourceGroupVersion?:number}>}):Promise<string[]>{
  const stepIds=input.steps.map(()=>randomUUID());
  await withTenant(pool,input.tenantId,async(client)=>{
    for(const [index,step]of input.steps.entries())await client.query(`INSERT INTO runs.steps(tenant_id,run_id,step_id,step_order,capability_id,capability_version,agent_id,state,idempotency_key,source_group_id,source_group_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$10)`,[input.tenantId,input.runId,stepIds[index],step.stepOrder,step.capabilityId,step.capabilityVersion,step.agentId,randomUUID(),step.sourceGroupId??null,step.sourceGroupVersion??null]);
  });
  return stepIds;
}

export async function transitionRun(pool: Pool,input:{tenantId:string;runId:string;to:RunState}):Promise<void>{
  await withTenant(pool,input.tenantId,async(client)=>{
    const current=await client.query<{state:RunState;state_version:number}>('SELECT state,state_version FROM runs.runs WHERE run_id=$1 FOR UPDATE',[input.runId]);
    const row=current.rows[0];
    if(!row || !canTransitionRun(row.state,input.to)) throw new Error('illegal_run_transition');
    await client.query('UPDATE runs.runs SET state=$2,state_version=state_version+1,updated_at=clock_timestamp() WHERE run_id=$1',[input.runId,input.to]);
    await appendEvent(client,input.runId,['COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED','POLICY_BLOCKED'].includes(input.to)?'run_terminal':'run_state_changed',{state:input.to,state_version:row.state_version+1});
  });
}

export async function claimNextStep(pool:Pool,workerId:string,leaseMs:number):Promise<StepClaim|null>{
  if(!workerId.trim()||!Number.isSafeInteger(leaseMs)||leaseMs<1) throw new Error('invalid_claim_arguments');
  const client=await pool.connect();
  try{
    await client.query('RESET app.tenant_id');
    await client.query('RESET app.worker_claim');
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.worker_claim','enabled',true)");
    const candidate=await client.query<{tenant_id:string;run_id:string;step_id:string}>(`
      SELECT tenant_id,run_id,step_id FROM runs.steps
      WHERE state='PENDING' OR (state IN ('CLAIMED','RUNNING') AND lease_expires_at<=clock_timestamp())
      ORDER BY created_at,step_order FOR UPDATE SKIP LOCKED LIMIT 1`);
    if(!candidate.rowCount){await client.query('COMMIT');return null;}
    const selected=candidate.rows[0]!;
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[selected.tenant_id]);
    const result=await client.query<{tenant_id:string;run_id:string;step_id:string;attempt:number;fencing_token:string}>(`
      UPDATE runs.steps SET state='CLAIMED',attempt=attempt+1,fencing_token=fencing_token+1,
        lease_owner=$4,lease_expires_at=clock_timestamp()+($5::text||' milliseconds')::interval
      WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3
      RETURNING tenant_id,run_id,step_id,attempt,fencing_token`,[selected.tenant_id,selected.run_id,selected.step_id,workerId,leaseMs]);
    const claim=result.rows[0]!;
    await client.query("SELECT set_config('app.worker_claim','',true)");
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[claim.tenant_id]);
    await appendEvent(client,claim.run_id,'step_claimed',{step_id:claim.step_id,attempt:claim.attempt,fencing_token:Number(claim.fencing_token)},claim.step_id,Number(claim.fencing_token));
    await client.query('COMMIT');
    return {tenantId:claim.tenant_id,runId:claim.run_id,stepId:claim.step_id,workerId,attempt:claim.attempt,fencingToken:Number(claim.fencing_token)};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function completeStep(pool:Pool,claim:StepClaim,input:{resultRef:string;analyticResult?:object}):Promise<boolean>{
  if(!input.resultRef || input.resultRef.length>500) throw new Error('invalid_result_ref');
  return withRunTenant(pool,claim.runId,async(client,stored)=>{
    const changed=await client.query(`UPDATE runs.steps SET state='SUCCEEDED',result_ref=$4,lease_owner=NULL,lease_expires_at=NULL
      WHERE run_id=$1 AND step_id=$2 AND tenant_id=$3 AND state IN ('CLAIMED','RUNNING') AND lease_owner=$5 AND fencing_token=$6 AND lease_expires_at>clock_timestamp()`,
      [claim.runId,claim.stepId,stored.tenant_id,input.resultRef,claim.workerId,claim.fencingToken]);
    if(!changed.rowCount) return false;
    const analytic=await client.query('SELECT 1 FROM runs.analytic_plans WHERE tenant_id=$1 AND run_id=$2',[stored.tenant_id,claim.runId]);
    if(analytic.rowCount&&input.analyticResult){
      await client.query('INSERT INTO runs.analytic_results(tenant_id,run_id,step_id,result) VALUES($1,$2,$3,$4::jsonb)',[stored.tenant_id,claim.runId,claim.stepId,JSON.stringify(input.analyticResult)]);
      await appendEvent(client,claim.runId,'evidence_added',{step_id:claim.stepId,result_ref:input.resultRef},claim.stepId,claim.fencingToken);
    }
    await appendEvent(client,claim.runId,'step_succeeded',{step_id:claim.stepId,result_ref:input.resultRef,fencing_token:claim.fencingToken},claim.stepId,claim.fencingToken);
    const remaining=await client.query<{count:string}>(analytic.rowCount
      ? "SELECT count(*)::text AS count FROM runs.steps WHERE run_id=$1 AND state IN ('PENDING','CLAIMED','RUNNING')"
      : "SELECT count(*)::text AS count FROM runs.steps WHERE run_id=$1 AND state<>'SUCCEEDED'",[claim.runId]);
    if(Number(remaining.rows[0]?.count??0)===0){
      const run=await client.query<{state:RunState;state_version:number}>('SELECT state,state_version FROM runs.runs WHERE run_id=$1 FOR UPDATE',[claim.runId]);
      if(run.rows[0]?.state==='RUNNING'){
        const version=run.rows[0].state_version+1;
        await client.query("UPDATE runs.runs SET state='FINALISING',state_version=$2,updated_at=clock_timestamp() WHERE run_id=$1",[claim.runId,version]);
        await appendEvent(client,claim.runId,'run_state_changed',{state:'FINALISING',state_version:version});
        if(!analytic.rowCount){
          await client.query("UPDATE runs.runs SET state='COMPLETED',state_version=state_version+1,updated_at=clock_timestamp() WHERE run_id=$1",[claim.runId]);
          await appendEvent(client,claim.runId,'run_terminal',{state:'COMPLETED',state_version:version+1});
        }
      }
    }
    return true;
  });
}

export async function failStep(pool:Pool,claim:StepClaim,input:{reasonCode:string}):Promise<boolean>{
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(input.reasonCode))throw new Error('invalid_reason_code');
  return withRunTenant(pool,claim.runId,async(client,stored)=>{
    const changed=await client.query(`UPDATE runs.steps SET state='FAILED',lease_owner=NULL,lease_expires_at=NULL
      WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND state IN ('CLAIMED','RUNNING') AND lease_owner=$4 AND fencing_token=$5 AND lease_expires_at>clock_timestamp()`,
      [stored.tenant_id,claim.runId,claim.stepId,claim.workerId,claim.fencingToken]);
    if(!changed.rowCount)return false;
    await appendEvent(client,claim.runId,'step_failed',{step_id:claim.stepId,attempt:claim.attempt,fencing_token:claim.fencingToken,reason_codes:[input.reasonCode]},claim.stepId,claim.fencingToken);
    const analytic=await client.query('SELECT 1 FROM runs.analytic_plans WHERE tenant_id=$1 AND run_id=$2',[stored.tenant_id,claim.runId]);
    if(analytic.rowCount){
      const remaining=await client.query<{count:string}>("SELECT count(*)::text AS count FROM runs.steps WHERE tenant_id=$1 AND run_id=$2 AND state IN ('PENDING','CLAIMED','RUNNING')",[stored.tenant_id,claim.runId]);
      if(Number(remaining.rows[0]?.count??0)===0){
        const run=await client.query<{state_version:number}>('UPDATE runs.runs SET state=\'FINALISING\',state_version=state_version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2 AND state=\'RUNNING\' RETURNING state_version',[stored.tenant_id,claim.runId]);
        if(run.rowCount)await appendEvent(client,claim.runId,'run_state_changed',{state:'FINALISING',state_version:run.rows[0]!.state_version});
      }
    }
    return true;
  });
}

export async function recordEffectIntent(pool:Pool,claim:StepClaim,input:{target:string;payloadHash:string}):Promise<void>{
  if(!/^[a-z][a-z0-9_.-]{0,99}$/.test(input.target)||!/^[a-f0-9]{64}$/.test(input.payloadHash))throw new Error('invalid_effect_intent');
  await withRunTenant(pool,claim.runId,async(client,stored)=>{
    const step=await client.query<{idempotency_key:string}>('SELECT idempotency_key FROM runs.steps WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND fencing_token=$4 AND lease_owner=$5 AND lease_expires_at>clock_timestamp() FOR UPDATE',[stored.tenant_id,claim.runId,claim.stepId,claim.fencingToken,claim.workerId]);
    if(!step.rowCount)throw new Error('stale_worker_claim');
    const payload={step_id:claim.stepId,target:input.target,payload_hash:input.payloadHash,idempotency_key:step.rows[0]!.idempotency_key};
    await client.query(`INSERT INTO runs.outbox(tenant_id,run_id,destination,payload) VALUES($1,$2,$3,$4::jsonb)`,[stored.tenant_id,claim.runId,input.target,JSON.stringify(payload)]);
    await appendEvent(client,claim.runId,'effect_intent_recorded',{step_id:claim.stepId,target:input.target,payload_hash:input.payloadHash,idempotency_key:step.rows[0]!.idempotency_key},claim.stepId,claim.fencingToken);
  });
}

export async function markEffectUnknown(pool:Pool,claim:StepClaim):Promise<boolean>{
  return withRunTenant(pool,claim.runId,async(client,stored)=>{
    const changed=await client.query(`UPDATE runs.steps SET state='OUTCOME_UNKNOWN',lease_owner=NULL,lease_expires_at=NULL
      WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND state IN ('CLAIMED','RUNNING') AND lease_owner=$4 AND fencing_token=$5 AND lease_expires_at>clock_timestamp()`,
      [stored.tenant_id,claim.runId,claim.stepId,claim.workerId,claim.fencingToken]);
    if(!changed.rowCount)return false;
    await appendEvent(client,claim.runId,'effect_unknown',{step_id:claim.stepId,effect_state:'unknown',fencing_token:claim.fencingToken},claim.stepId,claim.fencingToken);
    return true;
  });
}

export async function retryPartialRun(pool:Pool,input:{tenantId:string;parentRunId:string}):Promise<DurableRun>{
  const childRunId=randomUUID();
  await withTenant(pool,input.tenantId,async(client)=>{
    const parent=await client.query<{state:RunState;principal_id:string}>('SELECT state,principal_id FROM runs.runs WHERE run_id=$1 FOR UPDATE',[input.parentRunId]);
    const row=parent.rows[0];
    if(!row||row.state!=='PARTIAL')throw new Error('parent_run_not_partial');
    await client.query(`INSERT INTO runs.runs(tenant_id,run_id,principal_id,parent_run_id,state) VALUES($1,$2,$3,$4,'CREATED')`,[input.tenantId,childRunId,row.principal_id,input.parentRunId]);
    await appendEvent(client,input.parentRunId,'child_run_created',{parent_run_id:input.parentRunId,child_run_id:childRunId});
    await appendEvent(client,childRunId,'child_run_created',{parent_run_id:input.parentRunId,child_run_id:childRunId});
    for(const [state,stateVersion]of [['PLANNING',1],['PLAN_VALIDATED',2],['RUNNING',3]] as const){
      await client.query('UPDATE runs.runs SET state=$2,state_version=$3,updated_at=clock_timestamp() WHERE run_id=$1',[childRunId,state,stateVersion]);
      await appendEvent(client,childRunId,'run_state_changed',{state,state_version:stateVersion});
    }
    const failed=await client.query<{step_order:number;capability_id:string;capability_version:number;agent_id:string;source_group_id:string|null;source_group_version:number|null}>(
      `SELECT step_order,capability_id,capability_version,agent_id,source_group_id,source_group_version FROM runs.steps WHERE run_id=$1 AND state IN ('FAILED','BLOCKED') ORDER BY step_order`,[input.parentRunId]);
    for(const step of failed.rows){
      await client.query(`INSERT INTO runs.steps(tenant_id,run_id,step_order,capability_id,capability_version,agent_id,state,idempotency_key,reused_from_run_id,source_group_id,source_group_version)
        VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9,$10)`,[input.tenantId,childRunId,step.step_order,step.capability_id,step.capability_version,step.agent_id,randomUUID(),input.parentRunId,step.source_group_id,step.source_group_version]);
    }
  });
  return {runId:childRunId};
}

export function replayRunState(events:RunEvent[]):RunState{
  if(!events.length)throw new Error('event_stream_empty');
  const ordered=[...events].sort((a,b)=>a.sequence-b.sequence);
  for(let index=0;index<ordered.length;index++)if(ordered[index]!.sequence!==index+1)throw new Error('event_stream_gap');
  let state:RunState='CREATED';
  for(const event of ordered){
    if(event.event_type==='run_created'||event.event_type==='child_run_created')state='CREATED';
    if(event.event_type==='run_state_changed'||event.event_type==='run_terminal'){
      const next=event.safe_payload.state;
      if(next&&['CREATED','PLANNING','PLAN_VALIDATED','RUNNING','AWAITING_APPROVAL','FINALISING','COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED','POLICY_BLOCKED'].includes(next))state=next as RunState;
    }
  }
  return state;
}

export async function eventsAfter(pool:Pool,tenantId:string,runId:string,lastSequence:number){
  return withTenant(pool,tenantId,async(client)=>{
    const result=await client.query<{tenant_id:string;run_id:string;event_id:string;step_id:string|null;sequence:string;event_type:string;at:Date;fencing_token:string|null;safe_payload:Record<string,unknown>;decision_id:string|null;trace_id:string}>(
      'SELECT tenant_id,run_id,event_id,step_id,sequence,event_type,at,fencing_token,safe_payload,decision_id,trace_id FROM runs.events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence',[runId,lastSequence]);
    return result.rows.map(row=>({...row,sequence:Number(row.sequence),fencing_token:row.fencing_token===null?null:Number(row.fencing_token),at:row.at.toISOString()}));
  });
}

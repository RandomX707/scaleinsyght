import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { withTenant } from '@scaleinsyght/db';
import { createRun, addRunStep, claimNextStep, completeStep, failStep, recordEffectIntent, markEffectUnknown, retryPartialRun, replayRunState, transitionRun, eventsAfter } from '@scaleinsyght/runner';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString();
}
const worker = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER'), max: 3 });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE'), max: 2 });

async function spawnWorker(mode:'crash'|'crash-after-boundary'|'recover',workerId:string,tenantId:string):Promise<{process:ChildProcess;claim:Awaited<ReturnType<typeof claimNextStep>>;exit:Promise<[number|null,NodeJS.Signals|null]>}>{
  const child=spawn(process.execPath,['--import','tsx','tests/support/crash-worker.ts',mode,workerId,tenantId],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  const exit=once(child,'exit') as Promise<[number|null,NodeJS.Signals|null]>;
  let output='';let errorOutput='';child.stderr?.on('data',chunk=>{errorOutput+=String(chunk);});
  const claim=await new Promise<Awaited<ReturnType<typeof claimNextStep>>>((resolve,reject)=>{
    child.stdout?.on('data',chunk=>{output+=String(chunk);const line=output.split('\n')[0];if(line){try{resolve(JSON.parse(line) as Awaited<ReturnType<typeof claimNextStep>>);}catch(error){reject(error);}}});
    child.once('error',reject);child.once('exit',(code)=>{if(!output&&code!==null)reject(new Error(`worker exited ${code}: ${errorOutput}`));});
  });
  return{process:child,claim,exit};
}

describe('contract 5 durable runner', () => {
  afterAll(async () => { await worker.end(); await migrate.end(); });

  it('c5_racing_workers_claim_step_once_and_fence_completion', async () => {
    const tenant = `runner-${crypto.randomUUID()}`;
    let principal = '';
    let agent = '';
    await withTenant(migrate, tenant, async (db) => {
      await db.query('INSERT INTO core.tenants (tenant_id,name) VALUES ($1,$1)', [tenant]);
      principal = (await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[tenant,`${tenant}@synthetic.example`])).rows[0]!.user_id;
      agent = (await db.query<{agent_id:string}>(`INSERT INTO registry.agents(tenant_id,agent_type,status,owner_id) VALUES($1,'connector','active',$2) RETURNING agent_id`,[tenant,principal])).rows[0]!.agent_id;
    });
    const run = await createRun(migrate, { tenantId: tenant, principalId: principal });
    const stepId = await addRunStep(migrate, { tenantId: tenant, runId: run.runId, capabilityId: 'golden.read', capabilityVersion: 1, agentId: agent, stepOrder: 1 });
    await transitionRun(migrate, { tenantId: tenant, runId: run.runId, to: 'PLANNING' });
    await transitionRun(migrate, { tenantId: tenant, runId: run.runId, to: 'PLAN_VALIDATED' });
    await transitionRun(migrate, { tenantId: tenant, runId: run.runId, to: 'RUNNING' });

    // Both workers race for this tenant's single step. Every claim in this file is scoped to its test's tenant: the
    // shared contract database also holds other suites' abandoned steps, and once their leases expire an unscoped claim
    // correctly takes them first (oldest first). That made these tests flaky without any race in the runner (K4).
    const claims = await Promise.all([
      claimNextStep(worker, 'worker-a', 10_000, tenant),
      claimNextStep(worker, 'worker-b', 10_000, tenant),
    ]);
    const claim = claims.find(Boolean)!;
    expect(claim?.stepId).toBe(stepId);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(completeStep(worker, claim!, { resultRef: 'golden://result/one' })).resolves.toBe(true);
    await expect(completeStep(worker, claim!, { resultRef: 'golden://result/late' })).resolves.toBe(false);
    const finalState=await withTenant(migrate,tenant,async(db)=>{
      const state=await db.query<{state:string}>('SELECT state FROM runs.runs WHERE run_id=$1',[run.runId]);
      const steps=await db.query<{step_order:number;state:string}>('SELECT step_order,state FROM runs.steps WHERE run_id=$1 ORDER BY step_order',[run.runId]);
      return{state:state.rows[0]?.state,steps:steps.rows};
    });
    expect(finalState.state,JSON.stringify(finalState)).toBe('COMPLETED');
    const stream = await eventsAfter(migrate, tenant, run.runId, 0);
    expect(stream.map(event => event.sequence)).toEqual([1,2,3,4,5,6,7,8]);
    expect(stream.filter(event=>event.event_type==='step_succeeded')).toHaveLength(1);
    expect(stream.at(-1)?.event_type).toBe('run_terminal');
  });

  it('c5_illegal_run_state_transition_is_refused', async () => {
    const tenant = `runner-${crypto.randomUUID()}`;
    let principal = '';
    await withTenant(migrate, tenant, async (db) => {
      await db.query('INSERT INTO core.tenants (tenant_id,name) VALUES ($1,$1)', [tenant]);
      principal = (await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[tenant,`${tenant}@synthetic.example`])).rows[0]!.user_id;
    });
    const run = await createRun(migrate, { tenantId: tenant, principalId: principal });
    await expect(transitionRun(migrate,{tenantId:tenant,runId:run.runId,to:'COMPLETED'})).rejects.toThrow('illegal_run_transition');
  });

  it('c5_event_stream_resumes_after_last_event_id_once_in_order',async()=>{
    const tenant=`resume-${crypto.randomUUID()}`;let principal='';
    await withTenant(migrate,tenant,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenant]);principal=(await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[tenant,`${tenant}@synthetic.example`])).rows[0]!.user_id;});
    const run=await createRun(migrate,{tenantId:tenant,principalId:principal});
    await transitionRun(migrate,{tenantId:tenant,runId:run.runId,to:'PLANNING'});
    await transitionRun(migrate,{tenantId:tenant,runId:run.runId,to:'PLAN_VALIDATED'});
    await transitionRun(migrate,{tenantId:tenant,runId:run.runId,to:'RUNNING'});
    const resumed=await eventsAfter(migrate,tenant,run.runId,2);
    expect(resumed.map(event=>event.sequence)).toEqual([3,4]);
  });

  it('c5_event_replay_rebuilds_stored_run_state',async()=>{
    const tenant=`replay-${crypto.randomUUID()}`;let principal='';
    await withTenant(migrate,tenant,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenant]);principal=(await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[tenant,`${tenant}@synthetic.example`])).rows[0]!.user_id;});
    const run=await createRun(migrate,{tenantId:tenant,principalId:principal});
    for(const to of ['PLANNING','PLAN_VALIDATED','RUNNING','FINALISING','COMPLETED'] as const)await transitionRun(migrate,{tenantId:tenant,runId:run.runId,to});
    expect(replayRunState(await eventsAfter(migrate,tenant,run.runId,0))).toBe('COMPLETED');
  });

  it('c5_lost_effect_response_is_unknown_and_never_blindly_retried',async()=>{
    const tenant=`effect-${crypto.randomUUID()}`;let principal='';let agent='';
    await withTenant(migrate,tenant,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenant]);principal=(await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[tenant,`${tenant}@synthetic.example`])).rows[0]!.user_id;agent=(await db.query<{agent_id:string}>(`INSERT INTO registry.agents(tenant_id,agent_type,status,owner_id) VALUES($1,'connector','active',$2) RETURNING agent_id`,[tenant,principal])).rows[0]!.agent_id;});
    const run=await createRun(migrate,{tenantId:tenant,principalId:principal});
    await addRunStep(migrate,{tenantId:tenant,runId:run.runId,capabilityId:'synthetic.effect',capabilityVersion:1,agentId:agent,stepOrder:1});
    for(const to of ['PLANNING','PLAN_VALIDATED','RUNNING'] as const)await transitionRun(migrate,{tenantId:tenant,runId:run.runId,to});
    const claim=await claimNextStep(worker,'effect-worker',60_000,tenant);
    await recordEffectIntent(worker,claim!,{target:'synthetic.sink',payloadHash:'a'.repeat(64)});
    await expect(markEffectUnknown(worker,claim!)).resolves.toBe(true);
    const state=await withTenant(migrate,tenant,async(db)=>db.query<{state:string}>('SELECT state FROM runs.steps WHERE run_id=$1',[run.runId]));
    expect(state.rows[0]?.state).toBe('OUTCOME_UNKNOWN');
    expect(await claimNextStep(worker,'effect-retry',60_000,tenant)).toBeNull();
    expect((await eventsAfter(migrate,tenant,run.runId,0)).map(event=>event.event_type)).toContain('effect_unknown');
  });

  it('c5_worker_crash_at_every_step_boundary_recovers_20_runs_across_two_tenants', async () => {
    const completed: Array<{tenant:string;runId:string}> = [];
    const suffix=crypto.randomUUID();
    const tenants=[
      {tenant:`golden-tenant-north-recovery-${suffix}`,label:'Meridian North Synthetic',principal:'',agent:''},
      {tenant:`golden-tenant-south-recovery-${suffix}`,label:'Meridian South Synthetic',principal:'',agent:''},
    ];
    for(const context of tenants)await withTenant(migrate,context.tenant,async(db)=>{
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$2)',[context.tenant,context.label]);
      context.principal=(await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[context.tenant,`${context.tenant}@synthetic.example`])).rows[0]!.user_id;
      context.agent=(await db.query<{agent_id:string}>(`INSERT INTO registry.agents(tenant_id,agent_type,status,owner_id) VALUES($1,'connector','active',$2) RETURNING agent_id`,[context.tenant,context.principal])).rows[0]!.agent_id;
    });
    for(let index=0;index<20;index++){
      const context=tenants[index%2]!;const tenant=context.tenant;
      const run=await createRun(migrate,{tenantId:tenant,principalId:context.principal});
      await addRunStep(migrate,{tenantId:tenant,runId:run.runId,capabilityId:'golden.read',capabilityVersion:1,agentId:context.agent,stepOrder:1});
      const secondStep=await addRunStep(migrate,{tenantId:tenant,runId:run.runId,capabilityId:'golden.read',capabilityVersion:1,agentId:context.agent,stepOrder:2});
      await transitionRun(migrate,{tenantId:tenant,runId:run.runId,to:'PLANNING'});
      await transitionRun(migrate,{tenantId:tenant,runId:run.runId,to:'PLAN_VALIDATED'});
      await transitionRun(migrate,{tenantId:tenant,runId:run.runId,to:'RUNNING'});
      const crashedWorker=await spawnWorker('crash-after-boundary',`crashed-${index}`,tenant);
      const crashed=crashedWorker.claim;
      expect(crashed?.runId).toBe(run.runId);
      expect(crashed?.stepId).toBe(secondStep);
      const completedBoundary=await withTenant(migrate,tenant,async(db)=>db.query<{state:string}>('SELECT state FROM runs.steps WHERE run_id=$1 ORDER BY step_order LIMIT 1',[run.runId]));
      expect(completedBoundary.rows[0]?.state).toBe('SUCCEEDED');
      crashedWorker.process.kill('SIGKILL');
      const [crashCode,crashSignal]=await crashedWorker.exit;
      expect(crashCode).toBeNull();
      expect(crashSignal).toBe('SIGKILL');
      await withTenant(migrate,tenant,async(db)=>db.query(`UPDATE runs.steps SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`,[run.runId]));
      const recoveredWorker=await spawnWorker('recover',`restarted-${index}`,tenant);
      const resumed=recoveredWorker.claim;
      const [recoverCode,recoverSignal]=await recoveredWorker.exit;
      expect(recoverCode).toBe(0);
      expect(recoverSignal).toBeNull();
      expect(resumed?.runId).toBe(run.runId);
      expect(resumed?.attempt).toBe(2);
      expect(resumed?.fencingToken).toBe(crashed!.fencingToken+1);
      await expect(completeStep(worker,crashed!,{resultRef:'golden://phase0/stale'})).resolves.toBe(false);
      const events=await eventsAfter(migrate,tenant,run.runId,0);
      expect(events.map(event=>event.sequence)).toEqual([1,2,3,4,5,6,7,8,9,10,11]);
      expect(replayRunState(events)).toBe('COMPLETED');
      completed.push({tenant,runId:run.runId});
    }
    expect(completed).toHaveLength(20);
    expect(new Set(completed.map(item=>item.tenant)).size).toBe(2);
  });

  it('c5_partial_retry_creates_child_and_preserves_parent_events', async()=>{
    const tenant=`child-${crypto.randomUUID()}`;let principal='';let agent='';
    await withTenant(migrate,tenant,async(db)=>{
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenant]);
      principal=(await db.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`,[tenant,`${tenant}@synthetic.example`])).rows[0]!.user_id;
      agent=(await db.query<{agent_id:string}>(`INSERT INTO registry.agents(tenant_id,agent_type,status,owner_id) VALUES($1,'connector','active',$2) RETURNING agent_id`,[tenant,principal])).rows[0]!.agent_id;
    });
    const parent=await createRun(migrate,{tenantId:tenant,principalId:principal});
    await addRunStep(migrate,{tenantId:tenant,runId:parent.runId,capabilityId:'golden.read',capabilityVersion:1,agentId:agent,stepOrder:1});
    for(const to of ['PLANNING','PLAN_VALIDATED','RUNNING'] as const)await transitionRun(migrate,{tenantId:tenant,runId:parent.runId,to});
    const claim=await claimNextStep(worker,'child-failing-worker',60_000,tenant);
    await failStep(worker,claim!,{reasonCode:'synthetic_timeout'});
    await transitionRun(migrate,{tenantId:tenant,runId:parent.runId,to:'PARTIAL'});
    const before=await eventsAfter(migrate,tenant,parent.runId,0);
    const child=await retryPartialRun(migrate,{tenantId:tenant,parentRunId:parent.runId});
    const after=await eventsAfter(migrate,tenant,parent.runId,0);
    expect(after.slice(0,before.length)).toEqual(before);
    expect(after.at(-1)?.event_type).toBe('child_run_created');
    const childEvents=await eventsAfter(migrate,tenant,child.runId,0);
    expect(childEvents[0]?.event_type).toBe('child_run_created');
    expect(replayRunState(childEvents)).toBe('RUNNING');
    const childSteps=await withTenant(migrate,tenant,async(db)=>db.query<{state:string;reused_from_run_id:string|null}>('SELECT state,reused_from_run_id FROM runs.steps WHERE run_id=$1',[child.runId]));
    expect(childSteps.rows).toEqual([{state:'PENDING',reused_from_run_id:parent.runId}]);
    const childClaim=await claimNextStep(worker,'child-worker',60_000,tenant);
    await completeStep(worker,childClaim!,{resultRef:'golden://phase0/summary'});
  });
});

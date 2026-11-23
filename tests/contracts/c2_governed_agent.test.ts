import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { activateConnection } from '@scaleinsyght/registry';
import { executeGoldenStep, finalizeAnalyticRun } from '@scaleinsyght/analytic';
import { completeStep, type StepClaim } from '@scaleinsyght/runner';
import { withTenant } from '@scaleinsyght/db';
import type { AnalyticPlan } from '@scaleinsyght/contracts';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = '/si_test'; return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const worker = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

describe('contract 2 governed agent lifecycle', () => {
  afterAll(async () => { await app.end(); await worker.end(); await migrate.end(); });
  it('phase2_governed_agent_rerun_returns_identical_numbers_without_model_calls', async () => {
    const tenantId = `governed-api-${crypto.randomUUID()}`; let ownerId = '';
    await withTenant(migrate, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      ownerId = (await db.query<{user_id:string}>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id',[tenantId,`${tenantId}@synthetic.example`,hashPassword('synthetic-password')])).rows[0]!.user_id;
      await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)',[tenantId,`${tenantId}-approver@synthetic.example`,hashPassword('synthetic-password')]);
      await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)",[tenantId]);
    });
    const source=await activateConnection(app,{tenantId,principalId:ownerId,connectorType:'postgres'});
    await activateConnection(app,{tenantId,principalId:ownerId,connectorType:'postgres'});
    await withTenant(migrate,tenantId,async(db)=>db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)",[tenantId,ownerId,source.connectionId]));
    const server=await buildServer({pool:app,sessionSecret:'s'.repeat(64),goldenAccounts:[{tenantId,email:`${tenantId}@synthetic.example`},{tenantId,email:`${tenantId}-approver@synthetic.example`}]});
    try{
      const ownerLogin=await server.inject({method:'POST',url:'/api/auth/login',payload:{email:`${tenantId}@synthetic.example`,password:'synthetic-password'}});
      const approverLogin=await server.inject({method:'POST',url:'/api/auth/login',payload:{email:`${tenantId}-approver@synthetic.example`,password:'synthetic-password'}});
      const ownerCookie=String(ownerLogin.headers['set-cookie']);const approverCookie=String(approverLogin.headers['set-cookie']);
      const agentList=await server.inject({method:'GET',url:'/api/agents',headers:{cookie:ownerCookie}});expect(agentList.statusCode).toBe(200);expect(agentList.json().groups).toHaveLength(2);
      const authorizedSources=await server.inject({method:'GET',url:'/api/analytic/sources',headers:{cookie:ownerCookie}});expect(authorizedSources.statusCode).toBe(200);expect(authorizedSources.json().sources).toEqual([{id:source.connectionId,type:'postgres'}]);
      const evaluation=await server.inject({method:'GET',url:'/api/evaluation',headers:{cookie:ownerCookie}});expect(evaluation.statusCode).toBe(200);expect(evaluation.json()).toEqual({count:0,questionIds:[]});
      const draft=await server.inject({method:'POST',url:'/api/governed-agents',headers:{cookie:ownerCookie},payload:{name:'Synthetic listed objects',question:'How many catalog objects are listed?',sourceIds:[source.connectionId]}});
      expect(draft.statusCode).toBe(201);const governed=draft.json() as {governedId:string;version:number};expect(governed.version).toBe(1);
      const pending=await server.inject({method:'GET',url:'/api/agents',headers:{cookie:approverCookie}});expect(pending.json().governed).toEqual([expect.objectContaining({governedId:governed.governedId,version:1,approvedBy:null})]);
      const unapproved=await server.inject({method:'POST',url:`/api/governed-agents/${governed.governedId}/runs`,headers:{cookie:ownerCookie},payload:{version:1}});expect(unapproved.statusCode).toBe(404);
      const selfApproval=await server.inject({method:'POST',url:`/api/governed-agents/${governed.governedId}/approve`,headers:{cookie:ownerCookie},payload:{version:1}});expect(selfApproval.statusCode).toBe(403);
      const approval=await server.inject({method:'POST',url:`/api/governed-agents/${governed.governedId}/approve`,headers:{cookie:approverCookie},payload:{version:1}});expect(approval.statusCode).toBe(200);
      const firstRun=await server.inject({method:'POST',url:`/api/governed-agents/${governed.governedId}/runs`,headers:{cookie:ownerCookie},payload:{version:1}});expect(firstRun.statusCode).toBe(201);
      const edited=await server.inject({method:'POST',url:'/api/governed-agents',headers:{cookie:ownerCookie},payload:{governedId:governed.governedId,name:'Edited listed objects',question:'How many nightly unchanged objects are listed?',sourceIds:[source.connectionId]}});
      expect(edited.statusCode).toBe(201);expect((edited.json() as {version:number}).version).toBe(2);
      const v2Unapproved=await server.inject({method:'POST',url:`/api/governed-agents/${governed.governedId}/runs`,headers:{cookie:ownerCookie},payload:{version:2}});expect(v2Unapproved.statusCode).toBe(404);
      const secondRun=await server.inject({method:'POST',url:`/api/governed-agents/${governed.governedId}/runs`,headers:{cookie:ownerCookie},payload:{version:1}});expect(secondRun.statusCode).toBe(201);
      const runIds=[(firstRun.json() as {runId:string}).runId,(secondRun.json() as {runId:string}).runId];
      const outputs=[];
      for(const runId of runIds){
        const plan=(await withTenant(migrate,tenantId,async(db)=>db.query<{plan:AnalyticPlan}>('SELECT plan FROM runs.analytic_plans WHERE tenant_id=$1 AND run_id=$2',[tenantId,runId]))).rows[0]!.plan;
        for(const step of plan.steps){
          const workerId=`governed-${runId}`;
          await withTenant(migrate,tenantId,async(db)=>db.query("UPDATE runs.steps SET state='CLAIMED',attempt=1,fencing_token=1,lease_owner=$3,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE tenant_id=$1 AND run_id=$2 AND step_id=$4",[tenantId,runId,workerId,step.step_id]));
          const claim:StepClaim={tenantId,runId,stepId:step.step_id,workerId,attempt:1,fencingToken:1};
          const result=await executeGoldenStep({step,question:plan.question,connectorType:'postgres',groupId:source.sourceGroupId});
          expect(await completeStep(worker,claim,{resultRef:`golden://governed/${runId}/${step.step_id}`,analyticResult:result})).toBe(true);
          expect(await finalizeAnalyticRun(worker,runId)).toBe('COMPLETED');
        }
        outputs.push((await withTenant(migrate,tenantId,async(db)=>db.query<{answer:{bySource:Array<{value:number}>}}>('SELECT answer FROM runs.analytic_answers WHERE tenant_id=$1 AND run_id=$2',[tenantId,runId]))).rows[0]!.answer.bySource.map((item)=>item.value));
      }
      expect(outputs[0]).toEqual(outputs[1]);expect(outputs[0]).toEqual([12]);
      const versions=await withTenant(migrate,tenantId,async(db)=>db.query<{version:number;approver:string|null}>('SELECT v.version,a.approved_by AS approver FROM registry.governed_versions v LEFT JOIN registry.governed_approvals a USING(tenant_id,governed_id,version) WHERE v.tenant_id=$1 AND v.governed_id=$2 ORDER BY v.version',[tenantId,governed.governedId]));
      expect(versions.rows).toHaveLength(2);expect(versions.rows[0]?.approver).toBeTruthy();expect(versions.rows[1]?.approver).toBeNull();
      const pins=await withTenant(migrate,tenantId,async(db)=>db.query<{governed_id:string;version:number}>('SELECT governed_id,version FROM runs.governed_run_pins WHERE tenant_id=$1 AND run_id=ANY($2::uuid[]) ORDER BY run_id',[tenantId,runIds]));
      expect(pins.rows).toHaveLength(2);expect(pins.rows.every((pin)=>pin.governed_id===governed.governedId&&pin.version===1)).toBe(true);
      const defaults=await withTenant(migrate,tenantId,async(db)=>db.query<{allow_self_approval:boolean;time_zone:string}>('SELECT allow_self_approval,time_zone FROM core.tenants WHERE tenant_id=$1',[tenantId]));
      expect(defaults.rows[0]).toEqual({allow_self_approval:false,time_zone:'Asia/Kolkata'});
      expect((await server.inject({method:'GET',url:'/api/tenant/settings',headers:{cookie:ownerCookie}})).json()).toEqual({allowSelfApproval:false,timeZone:'Asia/Kolkata'});
      const third=await server.inject({method:'POST',url:'/api/governed-agents',headers:{cookie:ownerCookie},payload:{governedId:governed.governedId,name:'Self approval test',question:'How many catalog objects are listed?',sourceIds:[source.connectionId]}});
      expect(third.statusCode).toBe(201);expect((third.json() as {version:number}).version).toBe(3);
      await withTenant(migrate,tenantId,async(db)=>db.query('UPDATE core.tenants SET allow_self_approval=true WHERE tenant_id=$1',[tenantId]));
      expect((await server.inject({method:'PUT',url:'/api/tenant/settings',headers:{cookie:ownerCookie},payload:{allowSelfApproval:true,timeZone:'America/New_York'}})).json()).toEqual({allowSelfApproval:true,timeZone:'America/New_York'});
      const allowedSelfApproval=await server.inject({method:'POST',url:`/api/governed-agents/${governed.governedId}/approve`,headers:{cookie:ownerCookie},payload:{version:3}});
      expect(allowedSelfApproval.statusCode).toBe(200);
      const selfAudit=await withTenant(migrate,tenantId,async(db)=>db.query<{event_type:string;principal_id:string}>('SELECT event_type,principal_id FROM registry.governed_events WHERE tenant_id=$1 AND governed_id=$2 AND version=3 ORDER BY created_at DESC LIMIT 1',[tenantId,governed.governedId]));
      expect(selfAudit.rows[0]).toEqual({event_type:'self_approved',principal_id:ownerId});
    }finally{await server.close();}
  });
});

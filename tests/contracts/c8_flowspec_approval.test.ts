import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildTestServer as buildServer } from '../support/test-api.js';
import { hashPassword } from '@scaleinsyght/api/server';
import { createGoldenHubAdapters,getGoldenHubFixtures } from '../support/golden-hub-adapters.js';
import { withTenant } from '@scaleinsyght/db';

config({path:'.env'});
function dbUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'){const value=process.env[key];if(!value)throw new Error(`${key} is required; PostgreSQL contract tests are never skipped or mocked`);const url=new URL(value);url.pathname=`/${process.env.SI_TEST_DATABASE??'si_test'}`;return url.toString();}
const appPool=new Pool({connectionString:dbUrl('DATABASE_URL')});const migrate=new Pool({connectionString:dbUrl('DATABASE_URL_MIGRATE')});
const tenantId=`flowspec-${crypto.randomUUID()}`;let ownerCookie='';let approverCookie='';let server:Awaited<ReturnType<typeof buildServer>>;
const spec=(name='Synthetic handoff')=>({name,sourceSnapshotIds:['00000000-0000-4000-8000-000000000001'],nodes:[{id:'read_source',kind:'read',capability:'metadata.read',inputs:{}},{id:'deliver_report',kind:'deliver',capability:'flowspec.handoff',inputs:{}}]});
describe('contract 8 immutable FlowSpec approval',()=>{
 beforeAll(async()=>{
  await withTenant(migrate,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);for(const email of ['owner','reviewer'])await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)',[tenantId,`${email}@synthetic.example`,hashPassword('synthetic-password')]);const studio=getGoldenHubFixtures().adapters.find(item=>item.product==='data_studio')!;await db.query("INSERT INTO hub.adapters(tenant_id,product,connected,current_version) VALUES($1,'data_studio',true,$2)",[tenantId,studio.version]);await db.query("INSERT INTO hub.adapter_versions(tenant_id,product,version,fixture_key,capabilities) VALUES($1,'data_studio',$2,$3,$4::jsonb)",[tenantId,studio.version,studio.fixtureKey,JSON.stringify(studio.capabilities)]);});
  server=await buildServer({pool:appPool,sessionSecret:'s'.repeat(64),testAccounts:[{tenantId,email:'owner@synthetic.example'},{tenantId,email:'reviewer@synthetic.example'}]});
  ownerCookie=String((await server.inject({method:'POST',url:'/api/auth/login',payload:{email:'owner@synthetic.example',password:'synthetic-password'}})).headers['set-cookie']);
  approverCookie=String((await server.inject({method:'POST',url:'/api/auth/login',payload:{email:'reviewer@synthetic.example',password:'synthetic-password'}})).headers['set-cookie']);
 });
 afterAll(async()=>{await server?.close();await appPool.end();await migrate.end();});
 it('c8_flowspec_hash_binds_version_snapshots_policy_and_expiry',async()=>{
  const created=await server.inject({method:'POST',url:'/api/flowspecs',headers:{cookie:ownerCookie},payload:spec()});expect(created.statusCode).toBe(201);const result=created.json() as {flowspecId:string;subjectHash:string};expect(result.subjectHash).toMatch(/^[a-f0-9]{64}$/);
  const persisted=await withTenant(migrate,tenantId,(db)=>db.query<{policy_version:string;source_snapshot_ids:string[];expires_at:Date;status:string}>('SELECT v.policy_version,v.source_snapshot_ids,a.expires_at,a.status FROM hub.flowspec_versions v JOIN hub.flowspec_approvals a USING(tenant_id,flowspec_id,version,subject_hash) WHERE v.tenant_id=$1 AND v.flowspec_id=$2',[tenantId,result.flowspecId]));expect(persisted.rows[0]).toMatchObject({policy_version:'phase4-v1',source_snapshot_ids:['00000000-0000-4000-8000-000000000001'],status:'pending'});expect(persisted.rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());
 });
 it('c8_requester_cannot_self_approve',async()=>{
  const created=await server.inject({method:'POST',url:'/api/flowspecs',headers:{cookie:ownerCookie},payload:spec('No self approval')});const {flowspecId}=created.json() as {flowspecId:string};const result=await server.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/approve`,headers:{cookie:ownerCookie},payload:{version:1}});expect(result.statusCode).toBe(403);expect(result.json()).toMatchObject({error:'second_member_required'});
 });
 it('c8_changed_flowspec_after_approval_requires_new_approval',async()=>{
  const created=await server.inject({method:'POST',url:'/api/flowspecs',headers:{cookie:ownerCookie},payload:spec('Original')});const {flowspecId,subjectHash}=created.json() as {flowspecId:string;subjectHash:string};
  expect((await server.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/approve`,headers:{cookie:approverCookie},payload:{version:1}})).statusCode).toBe(200);
  const revised=await server.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/versions`,headers:{cookie:ownerCookie},payload:spec('Changed')});expect(revised.statusCode).toBe(201);expect(revised.json()).toMatchObject({version:2,status:'pending_approval'});expect((revised.json() as {subjectHash:string}).subjectHash).not.toBe(subjectHash);
  const detail=await server.inject({method:'GET',url:`/api/flowspecs/${flowspecId}`,headers:{cookie:ownerCookie}});expect(detail.json()).toMatchObject({versions:[{version:1,approvalStatus:'approved'},{version:2,approvalStatus:'pending'}]});
 });
 it('c8_rejects_mutating_or_unsupported_steps',async()=>{
  const result=await server.inject({method:'POST',url:'/api/flowspecs',headers:{cookie:ownerCookie},payload:{...spec(),nodes:[{id:'bad',kind:'read',capability:'customer.deploy',inputs:{}}]}});expect(result.statusCode).toBe(400);
 });
 it('c8_handoff_without_valid_grant_is_refused_without_delivery',async()=>{
  const created=await server.inject({method:'POST',url:'/api/flowspecs',headers:{cookie:ownerCookie},payload:spec('No grant')});const {flowspecId}=created.json() as {flowspecId:string};const result=await server.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/handoff`,headers:{cookie:ownerCookie},payload:{version:1}});expect(result.statusCode).toBe(403);expect(result.json()).toMatchObject({error:'approved_unexpired_grant_required'});
  const count=await withTenant(migrate,tenantId,(db)=>db.query('SELECT handoff_id FROM hub.handoffs WHERE tenant_id=$1 AND flowspec_id=$2',[tenantId,flowspecId]));expect(count.rowCount).toBe(0);
 });
 it('c8_confirmed_handoff_reuses_the_same_receiver_record_and_outbox',async()=>{
  const created=await server.inject({method:'POST',url:'/api/flowspecs',headers:{cookie:ownerCookie},payload:spec('Idempotent receiver')});const {flowspecId}=created.json() as {flowspecId:string};
  expect((await server.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/approve`,headers:{cookie:approverCookie},payload:{version:1}})).statusCode).toBe(200);
  const first=await server.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/handoff`,headers:{cookie:ownerCookie},payload:{version:1}});expect(first.statusCode,first.body).toBe(200);expect(first.json()).toMatchObject({status:'confirmed',accepted:true});
  const replay=await server.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/handoff`,headers:{cookie:ownerCookie},payload:{version:1}});expect(replay.json()).toMatchObject({handoffId:first.json().handoffId,status:'confirmed',accepted:true});
  const rows=await withTenant(migrate,tenantId,async(db)=>{const counts=await db.query<{handoffs:string;outboxes:string;sent:string}>(`SELECT count(DISTINCT h.handoff_id)::text AS handoffs,count(DISTINCT o.message_id)::text AS outboxes,count(DISTINCT o.message_id) FILTER(WHERE o.sent_at IS NOT NULL)::text AS sent FROM hub.handoffs h JOIN runs.outbox o ON o.tenant_id=h.tenant_id AND o.message_id=h.outbox_message_id WHERE h.tenant_id=$1 AND h.flowspec_id=$2`,[tenantId,flowspecId]);const run=await db.query<{run_id:string}>('SELECT run_id::text FROM hub.handoffs WHERE tenant_id=$1 AND flowspec_id=$2',[tenantId,flowspecId]);return {counts:counts.rows[0]!,runId:run.rows[0]!.run_id};});expect(rows.counts).toMatchObject({handoffs:'1',outboxes:'1',sent:'1'});
  const events=await withTenant(migrate,tenantId,(db)=>db.query<{sequence:string;event_type:string;safe_payload:Record<string,unknown>}>('SELECT sequence,event_type,safe_payload FROM runs.events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence',[tenantId,rows.runId]));expect(events.rows.map(event=>event.event_type)).toEqual(['handoff_intent_created','run_terminal']);expect(events.rows.map(event=>Number(event.sequence))).toEqual([1,2]);expect(JSON.stringify(events.rows)).not.toMatch(/synthetic handoff|sourceSnapshotIds|deliver_report/i);
 });
 it('c8_single_use_grant_race_delivers_exactly_once',async()=>{
  const created=await server.inject({method:'POST',url:'/api/flowspecs',headers:{cookie:ownerCookie},payload:spec('Concurrent handoff')});const {flowspecId}=created.json() as {flowspecId:string};expect((await server.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/approve`,headers:{cookie:approverCookie},payload:{version:1}})).statusCode).toBe(200);
  const attempt=()=>server.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/handoff`,headers:{cookie:ownerCookie},payload:{version:1}});const results=await Promise.all([attempt(),attempt()]);expect(results.every(result=>[200,202].includes(result.statusCode))).toBe(true);expect(results.some(result=>result.statusCode===200)).toBe(true);expect(results[0]!.json().handoffId).toBe(results[1]!.json().handoffId);
  const counts=await withTenant(migrate,tenantId,(db)=>db.query<{handoffs:string;outboxes:string}>('SELECT count(DISTINCT h.handoff_id)::text AS handoffs,count(DISTINCT o.message_id)::text AS outboxes FROM hub.handoffs h JOIN runs.outbox o ON o.tenant_id=h.tenant_id AND o.message_id=h.outbox_message_id WHERE h.tenant_id=$1 AND h.flowspec_id=$2',[tenantId,flowspecId]));expect(counts.rows[0]).toEqual({handoffs:'1',outboxes:'1'});
 });
 it('c8_dropped_receiver_response_reconciles_by_key_without_duplicate_flowspec',async()=>{
  const golden=createGoldenHubAdapters(getGoldenHubFixtures());let deliveries=0;const dataStudio={...golden.dataStudio,async deliverFlowSpec(key:string,payload:Parameters<typeof golden.dataStudio.deliverFlowSpec>[1]){deliveries+=1;const receipt=await golden.dataStudio.deliverFlowSpec(key,payload);if(deliveries===1)throw new Error('synthetic_receiver_response_dropped');return receipt;}};
  const recoveryServer=await buildServer({pool:appPool,sessionSecret:'s'.repeat(64),testAccounts:[{tenantId,email:'owner@synthetic.example'},{tenantId,email:'reviewer@synthetic.example'}],hubAdapters:{semantics:golden.semantics,dataStudio}} as Parameters<typeof buildServer>[0]);
  try{
   const created=await recoveryServer.inject({method:'POST',url:'/api/flowspecs',headers:{cookie:ownerCookie},payload:spec('Lost response recovery')});const {flowspecId}=created.json() as {flowspecId:string};expect((await recoveryServer.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/approve`,headers:{cookie:approverCookie},payload:{version:1}})).statusCode).toBe(200);
   const lost=await recoveryServer.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/handoff`,headers:{cookie:ownerCookie},payload:{version:1}});expect(lost.statusCode).toBe(500);
   const pending=await withTenant(migrate,tenantId,(db)=>db.query<{handoff_id:string}>('SELECT handoff_id FROM hub.handoffs WHERE tenant_id=$1 AND flowspec_id=$2',[tenantId,flowspecId]));const recovered=await recoveryServer.inject({method:'GET',url:`/api/flowspecs/${flowspecId}/handoff/${pending.rows[0]!.handoff_id}`,headers:{cookie:ownerCookie}});expect(recovered.statusCode).toBe(200);expect(recovered.json()).toMatchObject({status:'reconciled',accepted:true});expect(deliveries).toBe(1);
   const count=await withTenant(migrate,tenantId,(db)=>db.query('SELECT handoff_id FROM hub.handoffs WHERE tenant_id=$1 AND flowspec_id=$2',[tenantId,flowspecId]));expect(count.rowCount).toBe(1);
  }finally{await recoveryServer.close();}
 });
 it('c8_crash_after_grant_claim_reuses_key_and_delivers_once',async()=>{
  const golden=createGoldenHubAdapters(getGoldenHubFixtures());let attempts=0;const dataStudio={...golden.dataStudio,async deliverFlowSpec(key:string,payload:Parameters<typeof golden.dataStudio.deliverFlowSpec>[1]){attempts+=1;if(attempts===1)throw new Error('synthetic_worker_crash_before_receiver');return golden.dataStudio.deliverFlowSpec(key,payload);}};
  const recoveryServer=await buildServer({pool:appPool,sessionSecret:'s'.repeat(64),testAccounts:[{tenantId,email:'owner@synthetic.example'},{tenantId,email:'reviewer@synthetic.example'}],hubAdapters:{semantics:golden.semantics,dataStudio}} as Parameters<typeof buildServer>[0]);
  try{const created=await recoveryServer.inject({method:'POST',url:'/api/flowspecs',headers:{cookie:ownerCookie},payload:spec('Crash recovery')});const {flowspecId}=created.json() as {flowspecId:string};expect((await recoveryServer.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/approve`,headers:{cookie:approverCookie},payload:{version:1}})).statusCode).toBe(200);const first=await recoveryServer.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/handoff`,headers:{cookie:ownerCookie},payload:{version:1}});expect(first.statusCode).toBe(500);const second=await recoveryServer.inject({method:'POST',url:`/api/flowspecs/${flowspecId}/handoff`,headers:{cookie:ownerCookie},payload:{version:1}});expect(second.statusCode).toBe(200);expect(second.json()).toMatchObject({status:'confirmed',accepted:true});expect(attempts).toBe(2);const count=await withTenant(migrate,tenantId,(db)=>db.query('SELECT handoff_id FROM hub.handoffs WHERE tenant_id=$1 AND flowspec_id=$2',[tenantId,flowspecId]));expect(count.rowCount).toBe(1);}finally{await recoveryServer.close();}
 });
});

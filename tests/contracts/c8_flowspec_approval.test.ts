import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildServer,hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';

config({path:'.env'});
function dbUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'){const value=process.env[key];if(!value)throw new Error(`${key} is required; PostgreSQL contract tests are never skipped or mocked`);const url=new URL(value);url.pathname='/si_test';return url.toString();}
const appPool=new Pool({connectionString:dbUrl('DATABASE_URL')});const migrate=new Pool({connectionString:dbUrl('DATABASE_URL_MIGRATE')});
const tenantId=`flowspec-${crypto.randomUUID()}`;let ownerCookie='';let approverCookie='';let server:Awaited<ReturnType<typeof buildServer>>;
const spec=(name='Synthetic handoff')=>({name,sourceSnapshotIds:['00000000-0000-4000-8000-000000000001'],nodes:[{id:'read_source',kind:'read',capability:'metadata.read',inputs:{}},{id:'deliver_report',kind:'deliver',capability:'flowspec.handoff',inputs:{}}]});
describe('contract 8 immutable FlowSpec approval',()=>{
 beforeAll(async()=>{
  await withTenant(migrate,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);for(const email of ['owner','reviewer'])await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)',[tenantId,`${email}@synthetic.example`,hashPassword('synthetic-password')]);});
  server=await buildServer({pool:appPool,sessionSecret:'s'.repeat(64),goldenAccounts:[{tenantId,email:'owner@synthetic.example'},{tenantId,email:'reviewer@synthetic.example'}]});
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
});

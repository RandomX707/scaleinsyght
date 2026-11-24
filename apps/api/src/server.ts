import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { withTenant, getUsage } from '@scaleinsyght/db';
import { activateConnection, approveGovernedVersion, createConnectionDraft, createGovernedDraft, deletePersonalMemory, getApprovedGovernedVersion, getPersonalMemory, moveConnectionToGroup, putPersonalMemory, type ConnectorType, type PersonalMemoryData } from '@scaleinsyght/registry';
import { decryptConnectionSecret, encryptConnectionSecret, createPostgresConnector, type ReadOnlyConnector, type SourceConnectorType } from '@scaleinsyght/connectors';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { getNotifications, markNotificationRead, readConnectionScope, readWorkbook, retireConnection, runProfile, saveConnectionScope, storeWorkbook } from '@scaleinsyght/profiler';
import { applyPersonalContext, createAnalyticPlan, startAnalyticRun, submitFeedback, type StructuredAnswer } from '@scaleinsyght/analytic';
import { eventsAfter } from '@scaleinsyght/runner';
import { AnalyticPlanSchema, FlowSpecSchema, hashPlan } from '@scaleinsyght/contracts';
import { compareGraphSnapshots, getIdentifierPath, getImpactRadius, importDbtManifest, listGraphAssertions, listGraphAssets, listGraphSnapshots, listIdentifierFields, listReports, queryLineage, reconcileAssertion, reviewGraphAssertion, traceIdentifier, verifyAssertionFromRun } from '@scaleinsyght/graph';
import { type DataStudioAdapter, type SemanticsAdapter } from '@scaleinsyght/hub-adapters';
import { nextScheduleInstant, renderEvidencePack, safeEvidencePack, type ExportFormat, type SafeEvidencePack } from '@scaleinsyght/reports';
import { ClaimSchema, EvidenceRefSchema } from '@scaleinsyght/contracts';
import { authorise } from '@scaleinsyght/policy';
import { createOidcAuthorizationRequest, verifyOidcIdToken } from '@scaleinsyght/auth-oidc';
import { createEnrollment, hashGatewaySecret, validateGatewayPlan, validateGatewayResult } from '@scaleinsyght/customer-gateway';

export interface TestSource { id: string; type: SourceConnectorType | 'dbt' | 'tableau' | 'power_bi'; name: string; }
export interface ServerOptions { pool: Pool; sessionSecret: string; testAccounts?: Array<{ tenantId: string; email: string }>; artifactStore?: EncryptedArtifactStore; oidcFetch?: typeof fetch; testSources?: TestSource[]; testConnectorFor?: (sourceId: string) => ReadOnlyConnector | null; hubAdapters?: { semantics: SemanticsAdapter; dataStudio: DataStudioAdapter }; }
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
function verifyPassword(password:string,encoded:string):boolean{
  const [salt,hash]=encoded.split(':');if(!salt||!hash)return false;
  const actual=scryptSync(password,salt,64);const expected=Buffer.from(hash,'hex');
  return expected.length===actual.length && timingSafeEqual(actual,expected);
}
function digest(value:string):Buffer{return createHash('sha256').update(value).digest();}
function oidcSubjectHash(tenantId:string,issuer:string,subject:string,secret:string):Buffer{return createHmac('sha256',secret).update('scale-insyght:oidc-subject:v1\0').update(tenantId).update('\0').update(issuer).update('\0').update(subject).digest();}
function sign(value:string,secret:string):string{return createHmac('sha256',secret).update(value).digest('base64url');}
function secureEqual(left:string,right:string):boolean{const a=Buffer.from(left);const b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
function cookieValue(header:string|undefined,name:string):string|null{
  if(!header)return null;return header.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${name}=`))?.slice(name.length+1)??null;
}
async function oidcDocument(fetcher:typeof fetch,url:string):Promise<Record<string,unknown>>{
  const response=await fetcher(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('oidc_provider_unavailable');
  const length=Number(response.headers.get('content-length')??0);if(length>1_048_576)throw new Error('oidc_provider_response_too_large');
  const text=await response.text();if(Buffer.byteLength(text,'utf8')>1_048_576)throw new Error('oidc_provider_response_too_large');
  const value=JSON.parse(text) as unknown;if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('oidc_provider_response_invalid');
  return value as Record<string,unknown>;
}
function oidcEndpoint(value:unknown):string{
  if(typeof value!=='string')throw new Error('oidc_provider_response_invalid');
  const url=new URL(value);if(url.protocol!=='https:')throw new Error('oidc_https_required');return url.toString();
}

export async function buildServer(options:ServerOptions):Promise<FastifyInstance>{
  if(options.sessionSecret.length<32)throw new Error('SESSION_SECRET must contain at least 32 characters');
  const app=Fastify({logger:false,bodyLimit:25*1024*1024});
  const oidcFetch=options.oidcFetch??fetch;
  const postgresConnectors=new Map<string,ReadOnlyConnector>();
  const connectorForConnection=async(tenantId:string,connectionId:string):Promise<ReadOnlyConnector>=>{
    const saved=await withTenant(options.pool,tenantId,async(client)=>client.query<{connector_type:string;source_ref:string|null;display_name:string;ciphertext:Buffer|null;nonce:Buffer|null;auth_tag:Buffer|null}>(
      `SELECT c.connector_type,c.source_ref,c.display_name,s.ciphertext,s.nonce,s.auth_tag
       FROM registry.connections c LEFT JOIN LATERAL (SELECT ciphertext,nonce,auth_tag FROM registry.connection_secrets
       WHERE tenant_id=c.tenant_id AND connection_id=c.connection_id ORDER BY secret_version DESC LIMIT 1) s ON true
       WHERE c.tenant_id=$1 AND c.connection_id=$2`,[tenantId,connectionId]));
    const row=saved.rows[0];if(!row)throw new Error('connection_not_found');
    if(row.source_ref){const injected=options.testConnectorFor?.(row.source_ref);if(injected)return injected;}
    const cached=postgresConnectors.get(connectionId);if(cached)return cached;
    if(row.connector_type!=='postgres'||!row.ciphertext||!row.nonce||!row.auth_tag)throw new Error('source_connection_requires_credentials');
    const secret=decryptConnectionSecret<{host:string;port:number;database:string;username:string;password:string;sslMode:'disable'|'require'|'verify-full'}>({version:1,ciphertext:row.ciphertext.toString('base64'),nonce:row.nonce.toString('base64'),authTag:row.auth_tag.toString('base64')});
    const url=new URL('postgresql://placeholder');url.hostname=secret.host;url.port=String(secret.port);url.username=secret.username;url.password=secret.password;url.pathname=`/${secret.database}`;url.searchParams.set('sslmode',secret.sslMode);
    const connector=createPostgresConnector({connectionString:url.toString(),id:connectionId,name:row.display_name||'PostgreSQL source',statementTimeoutMs:10_000,maxRows:1_000});postgresConnectors.set(connectionId,connector);return connector;
  };
  const availableConnectorSources=()=> (options.testSources??[]).filter(source=>['postgres','sql_server','snowflake','excel','lake','crm'].includes(source.type));
  app.get('/api/gateways',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const allowed=await withTenant(options.pool,current.tenantId,client=>client.query("SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='tenant.gateway.manage' AND allowed AND resource_id IS NULL LIMIT 1",[current.tenantId,current.userId]));
    if(!allowed.rowCount)return reply.code(403).send({error:'tenant_admin_required'});
    const gateways=await withTenant(options.pool,current.tenantId,client=>client.query<{gateway_id:string;source_connection_id:string;last_seen_at:Date|null;revoked_at:Date|null}>('SELECT gateway_id,source_connection_id,last_seen_at,revoked_at FROM gateway.clients WHERE tenant_id=$1 ORDER BY created_at DESC',[current.tenantId]));
    return reply.send({gateways:gateways.rows.map(row=>({gatewayId:row.gateway_id,sourceConnectionId:row.source_connection_id,lastSeenAt:row.last_seen_at,revokedAt:row.revoked_at}))});
  });
  app.post<{Params:{gatewayId:string}}>('/api/gateways/:gatewayId/revoke',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!/^[0-9a-f-]{36}$/i.test(request.params.gatewayId))return reply.code(400).send({error:'invalid_gateway_id'});
    const allowed=await withTenant(options.pool,current.tenantId,client=>client.query("SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='tenant.gateway.manage' AND allowed AND resource_id IS NULL LIMIT 1",[current.tenantId,current.userId]));
    if(!allowed.rowCount)return reply.code(403).send({error:'tenant_admin_required'});
    const revoked=await withTenant(options.pool,current.tenantId,async(client)=>{
      const result=await client.query('UPDATE gateway.clients SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND gateway_id=$2 AND revoked_at IS NULL RETURNING gateway_id',[current.tenantId,request.params.gatewayId]);
      if(result.rowCount)await client.query("INSERT INTO gateway.events(tenant_id,gateway_id,event_type,safe_status) VALUES($1,$2,'gateway_revoked','revoked')",[current.tenantId,request.params.gatewayId]);return Boolean(result.rowCount);
    });
    if(!revoked)return reply.code(404).send({error:'gateway_not_found'});return reply.send({gatewayId:request.params.gatewayId,status:'revoked'});
  });
  app.addHook('onClose',async()=>{await Promise.all([...postgresConnectors.values()].map(connector=>connector.close?.()));});
  const hubAdapters=options.hubAdapters??{
    semantics:{product:'semantics' as const,version:0,capabilities:[],connected:false,listCertifiedMetrics:()=>[],async queryCertifiedMetric(){throw new Error('hub_adapter_disconnected');}},
    dataStudio:{product:'data_studio' as const,version:0,capabilities:[],connected:false,async deliverFlowSpec(){throw new Error('hub_adapter_disconnected');},async lookupFlowSpec(){return null;}},
  };
  const gatewayAuth=async(request: { headers: Record<string, string | string[] | undefined> })=>{
    const header=request.headers.authorization;
    if(typeof header!=='string'||!header.startsWith('Bearer '))return null;
    const credential=header.slice(7);const parts=credential.split('.');
    if(parts.length!==3||!parts[0]||! /^[a-zA-Z0-9_-]{3,128}$/.test(parts[0])||! /^[0-9a-f-]{36}$/i.test(parts[1]!)||! /^[0-9a-f]{64}$/i.test(parts[2]!))return null;
    const [tenantId,gatewayId]=parts;
    try{
      return await withTenant(options.pool,tenantId!,async(client)=>{
        const found=await client.query<{credential_hash:Buffer;source_connection_id:string}>("SELECT c.credential_hash,c.source_connection_id FROM gateway.clients c JOIN registry.connections r ON r.tenant_id=c.tenant_id AND r.connection_id=c.source_connection_id WHERE c.tenant_id=$1 AND c.gateway_id=$2 AND c.revoked_at IS NULL AND r.status='active'",[tenantId,gatewayId]);
        const row=found.rows[0];if(!row)return null;
        const actual=Buffer.from(hashGatewaySecret(credential),'hex');
        if(actual.length!==row.credential_hash.length||!secureEqual(actual.toString('hex'),row.credential_hash.toString('hex')))return null;
        return {tenantId:tenantId!,gatewayId:gatewayId!,sourceConnectionId:row.source_connection_id};
      });
    }catch{return null;}
  };
  app.post('/api/gateways/enrollments',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const sourceConnectionId=String((request.body as {sourceConnectionId?:unknown})?.sourceConnectionId??'');
    if(!/^[0-9a-f-]{36}$/i.test(sourceConnectionId))return reply.code(400).send({error:'invalid_source_connection'});
    const allowed=await withTenant(options.pool,current.tenantId,client=>client.query("SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='tenant.gateway.manage' AND allowed AND resource_id IS NULL LIMIT 1",[current.tenantId,current.userId]));
    if(!allowed.rowCount)return reply.code(403).send({error:'tenant_admin_required'});
    const enrollment=await createEnrollment({tenantId:current.tenantId});
    const row=await withTenant(options.pool,current.tenantId,async(client)=>{
      const source=await client.query('SELECT 1 FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 AND status=\'active\'', [current.tenantId,sourceConnectionId]);
      if(!source.rowCount)return null;
      const inserted=await client.query<{enrollment_id:string}>('INSERT INTO gateway.enrollments(tenant_id,source_connection_id,token_hash,expires_at,created_by) VALUES($1,$2,$3,to_timestamp($4/1000.0),$5) RETURNING enrollment_id',[current.tenantId,sourceConnectionId,Buffer.from(enrollment.tokenHash,'hex'),enrollment.expiresAt,current.userId]);
      await client.query("INSERT INTO gateway.events(tenant_id,event_type,safe_status) VALUES($1,'gateway_enrollment_created','created')",[current.tenantId]);return inserted.rows[0];
    });
    if(!row)return reply.code(404).send({error:'connection_not_found'});
    return reply.code(201).send({enrollmentId:row.enrollment_id,token:enrollment.token,expiresAt:new Date(enrollment.expiresAt).toISOString()});
  });
  app.post('/api/gateways/claim',async(request,reply)=>{
    const body=request.body as {tenantId?:unknown;token?:unknown};const tenantId=String(body?.tenantId??'');const token=String(body?.token??'');
    if(!/^[a-zA-Z0-9_-]{3,128}$/.test(tenantId)||!/^[0-9a-f]{64}$/i.test(token))return reply.code(400).send({error:'gateway_claim_invalid'});
    const claimed=await withTenant(options.pool,tenantId,async(client)=>{
      const enrollment=await client.query<{enrollment_id:string;source_connection_id:string;consumed_at:Date|null;expires_at:Date}>('SELECT enrollment_id,source_connection_id,consumed_at,expires_at FROM gateway.enrollments WHERE tenant_id=$1 AND token_hash=$2 FOR UPDATE',[tenantId,Buffer.from(hashGatewaySecret(token),'hex')]);
      const row=enrollment.rows[0];if(!row||row.consumed_at||row.expires_at.getTime()<=Date.now())return null;
      await client.query('UPDATE gateway.enrollments SET consumed_at=clock_timestamp() WHERE tenant_id=$1 AND enrollment_id=$2',[tenantId,row.enrollment_id]);
      const gatewayId=randomUUID();const secret=randomBytes(32).toString('hex');const credential=`${tenantId}.${gatewayId}.${secret}`;
      await client.query('INSERT INTO gateway.clients(tenant_id,gateway_id,source_connection_id,credential_hash) VALUES($1,$2,$3,$4)',[tenantId,gatewayId,row.source_connection_id,Buffer.from(hashGatewaySecret(credential),'hex')]);
      await client.query("INSERT INTO gateway.events(tenant_id,gateway_id,event_type,safe_status) VALUES($1,$2,'gateway_claimed','claimed')",[tenantId,gatewayId]);
      return {gatewayId,credential};
    });
    if(!claimed)return reply.code(401).send({error:'gateway_enrollment_invalid'});return reply.code(201).send(claimed);
  });
  app.post('/api/gateways/requests',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const body=request.body as {gatewayId?:unknown;plan?:unknown};const gatewayId=String(body?.gatewayId??'');
    let validatedPlan;try{validatedPlan=await validateGatewayPlan(body?.plan);}catch{return reply.code(400).send({error:'gateway_plan_rejected'});}
    const sourceId=validatedPlan.scope.source_ids[0]!;
    const queued=await withTenant(options.pool,current.tenantId,async(client)=>{
      const gateway=await client.query<{source_connection_id:string}>("SELECT c.source_connection_id FROM gateway.clients c JOIN registry.connections r ON r.tenant_id=c.tenant_id AND r.connection_id=c.source_connection_id WHERE c.tenant_id=$1 AND c.gateway_id=$2 AND c.revoked_at IS NULL AND r.status='active'",[current.tenantId,gatewayId]);
      if(!gateway.rowCount||gateway.rows[0]!.source_connection_id!==sourceId)return null;
      const entitlement=await client.query("SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='analytic.read' AND allowed AND (resource_id IS NULL OR resource_id=$3) LIMIT 1",[current.tenantId,current.userId,sourceId]);if(!entitlement.rowCount)return null;
      const result=await client.query<{request_id:string}>('INSERT INTO gateway.requests(tenant_id,gateway_id,source_connection_id,plan) VALUES($1,$2,$3,$4::jsonb) RETURNING request_id',[current.tenantId,gatewayId,sourceId,JSON.stringify(validatedPlan)]);return result.rows[0];
    });
    if(!queued)return reply.code(403).send({error:'gateway_source_not_authorized'});return reply.code(202).send({requestId:queued.request_id,state:'queued'});
  });
  app.post('/api/gateways/poll',async(request,reply)=>{
    const gateway=await gatewayAuth(request);if(!gateway)return reply.code(401).send({error:'gateway_credential_invalid'});
    const claimed=await withTenant(options.pool,gateway.tenantId,async(client)=>{
      await client.query('UPDATE gateway.clients SET last_seen_at=clock_timestamp() WHERE tenant_id=$1 AND gateway_id=$2',[gateway.tenantId,gateway.gatewayId]);
      const expired=await client.query<{request_id:string;gateway_id:string}>("UPDATE gateway.requests SET state='expired',safe_failure_code='lease_attempts_exhausted',updated_at=clock_timestamp() WHERE tenant_id=$1 AND gateway_id=$2 AND state='leased' AND lease_expires_at<clock_timestamp() AND attempts>=5 RETURNING request_id,gateway_id",[gateway.tenantId,gateway.gatewayId]);
      for(const row of expired.rows)await client.query("INSERT INTO gateway.events(tenant_id,gateway_id,request_id,event_type,safe_status) VALUES($1,$2,$3,'gateway_request_expired','attempt_limit')",[gateway.tenantId,row.gateway_id,row.request_id]);
      const next=await client.query<{request_id:string;plan:unknown;attempts:number}>('SELECT request_id,plan,attempts FROM gateway.requests WHERE tenant_id=$1 AND gateway_id=$2 AND (state=\'queued\' OR (state=\'leased\' AND lease_expires_at<clock_timestamp())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1',[gateway.tenantId,gateway.gatewayId]);
      const row=next.rows[0];if(!row)return null;const lease=randomUUID();
      await client.query("UPDATE gateway.requests SET state='leased',lease_token=$3,lease_expires_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND request_id=$2",[gateway.tenantId,row.request_id,lease]);
      await client.query("INSERT INTO gateway.events(tenant_id,gateway_id,request_id,event_type,safe_status) VALUES($1,$2,$3,'gateway_request_claimed','leased')",[gateway.tenantId,gateway.gatewayId,row.request_id]);return {requestId:row.request_id,plan:row.plan,fencingToken:lease,attempt:row.attempts+1};
    });
    return reply.send({request:claimed});
  });
  app.post<{Params:{requestId:string}}>('/api/gateways/results/:requestId',async(request,reply)=>{
    const gateway=await gatewayAuth(request);if(!gateway)return reply.code(401).send({error:'gateway_credential_invalid'});
    let result;try{result=validateGatewayResult(request.body);}catch{return reply.code(400).send({error:'gateway_result_invalid'});}
    if(result.requestId!==request.params.requestId)return reply.code(400).send({error:'gateway_result_invalid'});
    const stableResult={requestId:result.requestId,fencingToken:result.fencingToken,aggregates:result.aggregates.map(item=>item.unit===undefined?{metric:item.metric,value:item.value}:{metric:item.metric,value:item.value,unit:item.unit})};
    const hash=Buffer.from(createHash('sha256').update(JSON.stringify(stableResult)).digest('hex'),'hex');
    const outcome=await withTenant(options.pool,gateway.tenantId,async(client)=>{
      const current=await client.query<{state:string;lease_token:string|null;result_hash:Buffer|null}>('SELECT state,lease_token,result_hash FROM gateway.requests WHERE tenant_id=$1 AND request_id=$2 AND gateway_id=$3 FOR UPDATE',[gateway.tenantId,request.params.requestId,gateway.gatewayId]);const row=current.rows[0];if(!row)return 'missing';
      if(row.state==='completed'&&row.result_hash?.equals(hash))return 'replayed';if(row.state!=='leased'||row.lease_token!==result.fencingToken)return 'stale';
      await client.query("UPDATE gateway.requests SET state='completed',result=$4::jsonb,result_hash=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND request_id=$2 AND lease_token=$3",[gateway.tenantId,request.params.requestId,result.fencingToken,JSON.stringify(result),hash]);
      await client.query("INSERT INTO gateway.events(tenant_id,gateway_id,request_id,event_type,safe_status) VALUES($1,$2,$3,'gateway_request_completed','completed')",[gateway.tenantId,gateway.gatewayId,request.params.requestId]);return 'completed';
    });
    if(outcome==='missing')return reply.code(404).send({error:'gateway_request_not_found'});if(outcome==='stale')return reply.code(409).send({error:'gateway_lease_stale'});return reply.send({status:outcome});
  });
  app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_request,payload,done)=>done(null,payload));
  app.get('/api/health',async()=>({status:'ok'}));
  app.get('/api/flowspecs',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query(
      `SELECT f.flowspec_id AS "flowspecId",f.owner_id AS "ownerId",f.latest_version AS "latestVersion",v.subject_hash AS "subjectHash",a.status AS "approvalStatus",a.expires_at AS "expiresAt"
       FROM hub.flowspecs f LEFT JOIN hub.flowspec_versions v ON v.tenant_id=f.tenant_id AND v.flowspec_id=f.flowspec_id AND v.version=f.latest_version
       LEFT JOIN hub.flowspec_approvals a ON a.tenant_id=v.tenant_id AND a.flowspec_id=v.flowspec_id AND a.version=v.version AND a.subject_hash=v.subject_hash
       WHERE f.tenant_id=$1 ORDER BY f.created_at DESC`,[current.tenantId]));
    return reply.send({flowspecs:result.rows});
  });
  app.post('/api/flowspecs',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const parsed=FlowSpecSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'invalid_flowspec',details:parsed.error.issues.map(({path,message})=>({path,message}))});
    const flowspecId=randomUUID();const payload=parsed.data;const subjectHash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');const sourceSnapshotHash=createHash('sha256').update(JSON.stringify([...payload.sourceSnapshotIds].sort())).digest('hex');
    await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query('INSERT INTO hub.flowspecs(tenant_id,flowspec_id,owner_id,latest_version) VALUES($1,$2,$3,1)',[current.tenantId,flowspecId,current.userId]);
      await client.query(`INSERT INTO hub.flowspec_versions(tenant_id,flowspec_id,version,payload,subject_hash,source_snapshot_ids,policy_version,created_by)
        VALUES($1,$2,1,$3::jsonb,$4,$5::jsonb,'phase4-v1',$6)`,[current.tenantId,flowspecId,JSON.stringify(payload),subjectHash,JSON.stringify(payload.sourceSnapshotIds),current.userId]);
      await client.query(`INSERT INTO hub.flowspec_approvals(tenant_id,flowspec_id,version,subject_hash,source_snapshot_hash,policy_version,requested_by,status,expires_at)
        VALUES($1,$2,1,$3,$4,'phase4-v1',$5,'pending',clock_timestamp()+interval '7 days')`,[current.tenantId,flowspecId,subjectHash,sourceSnapshotHash,current.userId]);
    });
    return reply.code(201).send({flowspecId,version:1,subjectHash,status:'pending_approval'});
  });
  app.get<{Params:{id:string}}>('/api/flowspecs/:id',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query(
      `SELECT f.flowspec_id AS "flowspecId",f.owner_id AS "ownerId",v.version,v.payload,v.subject_hash AS "subjectHash",v.source_snapshot_ids AS "sourceSnapshotIds",v.policy_version AS "policyVersion",a.status AS "approvalStatus",a.approved_by AS "approvedBy",a.expires_at AS "expiresAt",h.handoff_id AS "handoffId",h.status AS "handoffStatus",h.receiver_ref AS "receiverRef"
       FROM hub.flowspecs f JOIN hub.flowspec_versions v USING(tenant_id,flowspec_id) LEFT JOIN hub.flowspec_approvals a USING(tenant_id,flowspec_id,version,subject_hash)
       LEFT JOIN LATERAL (SELECT handoff_id,status,receiver_ref FROM hub.handoffs WHERE tenant_id=v.tenant_id AND flowspec_id=v.flowspec_id AND version=v.version ORDER BY created_at DESC LIMIT 1) h ON true
       WHERE f.tenant_id=$1 AND f.flowspec_id=$2 ORDER BY v.version`,[current.tenantId,request.params.id]));
    if(!result.rowCount)return reply.code(404).send({error:'flowspec_not_found'});return reply.send({versions:result.rows});
  });
  app.post<{Params:{id:string}}>('/api/flowspecs/:id/versions',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const parsed=FlowSpecSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'invalid_flowspec'});
    const payload=parsed.data;const subjectHash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');const sourceSnapshotHash=createHash('sha256').update(JSON.stringify([...payload.sourceSnapshotIds].sort())).digest('hex');
    const created=await withTenant(options.pool,current.tenantId,async(client)=>{
      const owner=await client.query<{owner_id:string;latest_version:number}>('SELECT owner_id,latest_version FROM hub.flowspecs WHERE tenant_id=$1 AND flowspec_id=$2 FOR UPDATE',[current.tenantId,request.params.id]);
      const row=owner.rows[0];if(!row)return {status:'missing' as const};if(row.owner_id!==current.userId)return {status:'forbidden' as const};
      const version=row.latest_version+1;
      await client.query('INSERT INTO hub.flowspec_versions(tenant_id,flowspec_id,version,payload,subject_hash,source_snapshot_ids,policy_version,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,\'phase4-v1\',$7)',[current.tenantId,request.params.id,version,JSON.stringify(payload),subjectHash,JSON.stringify(payload.sourceSnapshotIds),current.userId]);
      await client.query('UPDATE hub.flowspecs SET latest_version=$3 WHERE tenant_id=$1 AND flowspec_id=$2',[current.tenantId,request.params.id,version]);
      await client.query(`INSERT INTO hub.flowspec_approvals(tenant_id,flowspec_id,version,subject_hash,source_snapshot_hash,policy_version,requested_by,status,expires_at) VALUES($1,$2,$3,$4,$5,'phase4-v1',$6,'pending',clock_timestamp()+interval '7 days')`,[current.tenantId,request.params.id,version,subjectHash,sourceSnapshotHash,current.userId]);
      return {status:'created' as const,version};
    });
    if(created.status==='missing')return reply.code(404).send({error:'flowspec_not_found'});if(created.status==='forbidden')return reply.code(403).send({error:'flowspec_owner_required'});
    return reply.code(201).send({flowspecId:request.params.id,version:created.version,subjectHash,status:'pending_approval'});
  });
  app.post<{Params:{id:string}}>('/api/flowspecs/:id/approve',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const version=Number((request.body as {version?:unknown})?.version);if(!Number.isInteger(version)||version<1)return reply.code(400).send({error:'invalid_version'});
    const outcome=await withTenant(options.pool,current.tenantId,async(client)=>{
      const result=await client.query<{requested_by:string;expires_at:Date;status:string}>('SELECT requested_by,expires_at,status FROM hub.flowspec_approvals WHERE tenant_id=$1 AND flowspec_id=$2 AND version=$3 FOR UPDATE',[current.tenantId,request.params.id,version]);
      const approval=result.rows[0];if(!approval)return 'missing';if(approval.requested_by===current.userId)return 'self_approval';if(approval.status!=='pending'||approval.expires_at.getTime()<=Date.now())return 'not_pending';
      const approved=await client.query<{approval_id:string;subject_hash:string}>('UPDATE hub.flowspec_approvals SET approved_by=$4,status=\'approved\',decided_at=clock_timestamp() WHERE tenant_id=$1 AND flowspec_id=$2 AND version=$3 RETURNING approval_id,subject_hash',[current.tenantId,request.params.id,version,current.userId]);
      const key=createHash('sha256').update(`${current.tenantId}:${request.params.id}:${version}:${approved.rows[0]!.subject_hash}`).digest('hex');
      await client.query(`INSERT INTO hub.handoff_grants(tenant_id,approval_id,flowspec_id,version,subject_hash,expires_at,idempotency_key)
        SELECT tenant_id,approval_id,flowspec_id,version,subject_hash,expires_at,$4 FROM hub.flowspec_approvals WHERE tenant_id=$1 AND approval_id=$2 AND flowspec_id=$3`,[current.tenantId,approved.rows[0]!.approval_id,request.params.id,key]);return 'approved';
    });
    if(outcome==='missing')return reply.code(404).send({error:'approval_not_found'});if(outcome==='self_approval')return reply.code(403).send({error:'second_member_required'});if(outcome!=='approved')return reply.code(409).send({error:'approval_not_pending'});return reply.send({flowspecId:request.params.id,version,status:'approved'});
  });
  app.post<{Params:{id:string}}>('/api/flowspecs/:id/handoff',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const studio=await withTenant(options.pool,current.tenantId,(client)=>client.query<{connected:boolean}>("SELECT connected FROM hub.adapters WHERE tenant_id=$1 AND product='data_studio'",[current.tenantId]));
    if(!studio.rows[0]?.connected||!hubAdapters.dataStudio.connected)return reply.code(503).send({error:'hub_adapter_disconnected'});
    const version=Number((request.body as {version?:unknown})?.version);if(!Number.isInteger(version)||version<1)return reply.code(400).send({error:'invalid_version'});
    const delivery=await withTenant(options.pool,current.tenantId,async(client)=>{
      const existing=await client.query<{handoff_id:string;idempotency_key:string;payload_hash:string;status:string;receiver_ref:string|null}>('SELECT handoff_id,idempotency_key,payload_hash,status,receiver_ref FROM hub.handoffs WHERE tenant_id=$1 AND flowspec_id=$2 AND version=$3',[current.tenantId,request.params.id,version]);
      if(existing.rows[0])return {kind:'existing' as const,row:existing.rows[0],...(existing.rows[0].status==='pending'||existing.rows[0].status==='unknown'?{delivery:{flowspecId:request.params.id,version,payloadHash:existing.rows[0].payload_hash}}:{})};
      const approved=await client.query<{payload:Record<string,unknown>;subject_hash:string;grant_id:string;idempotency_key:string;expires_at:Date;consumed_at:Date|null}>(
        `SELECT v.payload,v.subject_hash,g.grant_id,g.idempotency_key,g.expires_at,g.consumed_at FROM hub.flowspec_versions v
         JOIN hub.flowspec_approvals a USING(tenant_id,flowspec_id,version,subject_hash) JOIN hub.handoff_grants g USING(tenant_id,approval_id,flowspec_id,version,subject_hash)
         WHERE v.tenant_id=$1 AND v.flowspec_id=$2 AND v.version=$3 AND a.status='approved' AND a.expires_at>clock_timestamp() FOR UPDATE OF g`,[current.tenantId,request.params.id,version]);
      const row=approved.rows[0];if(!row)return {kind:'no_grant' as const};
      if(row.expires_at.getTime()<=Date.now())return {kind:'expired' as const};
      if(row.consumed_at)return {kind:'consumed' as const};
      const runId=randomUUID();await client.query("INSERT INTO runs.runs(tenant_id,run_id,principal_id,state) VALUES($1,$2,$3,'RUNNING')",[current.tenantId,runId,current.userId]);
      const decision=await client.query<{decision_id:string}>("INSERT INTO runs.authz_decisions(tenant_id,run_id,principal_id,capability_id,outcome,policy_version,reasons) VALUES($1,$2,$3,'flowspec.handoff','allow','phase4-v1','[\"approved_single_use_grant\"]') RETURNING decision_id",[current.tenantId,runId,current.userId]);
      const payloadHash=createHash('sha256').update(JSON.stringify(row.payload)).digest('hex');
      const outbox=await client.query<{message_id:string}>("INSERT INTO runs.outbox(tenant_id,run_id,destination,payload) VALUES($1,$2,'data_studio',$3::jsonb) RETURNING message_id",[current.tenantId,runId,JSON.stringify({flowspecId:request.params.id,version,payloadHash})]);
      const handoff=await client.query<{handoff_id:string}>('INSERT INTO hub.handoffs(tenant_id,grant_id,flowspec_id,version,run_id,outbox_message_id,idempotency_key,payload_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,\'pending\') RETURNING handoff_id',[current.tenantId,row.grant_id,request.params.id,version,runId,outbox.rows[0]!.message_id,row.idempotency_key,payloadHash]);
      await client.query('UPDATE hub.handoff_grants SET consumed_at=clock_timestamp() WHERE tenant_id=$1 AND grant_id=$2',[current.tenantId,row.grant_id]);
      await client.query("INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,decision_id,safe_payload) VALUES($1,$2,1,'handoff_intent_created',$3,$4::jsonb)",[current.tenantId,runId,decision.rows[0]!.decision_id,JSON.stringify({flowspec_id:request.params.id,version,status:'pending',payload_hash:payloadHash})]);
      return {kind:'created' as const,row:{handoff_id:handoff.rows[0]!.handoff_id,idempotency_key:row.idempotency_key,payload_hash:payloadHash,status:'pending',receiver_ref:null},delivery:{flowspecId:request.params.id,version,payloadHash}};
    });
    if(delivery.kind==='no_grant')return reply.code(403).send({error:'approved_unexpired_grant_required'});if(delivery.kind==='expired')return reply.code(409).send({error:'handoff_grant_expired'});if(delivery.kind==='consumed')return reply.code(409).send({error:'handoff_grant_consumed'});
    const row=delivery.row;
    if(row.status==='confirmed'||row.status==='reconciled')return reply.send({handoffId:row.handoff_id,status:row.status,accepted:true,receiverRef:row.receiver_ref});
    const lookup=await hubAdapters.dataStudio.lookupFlowSpec(row.idempotency_key) as {status?:string;receiverRef?:string}|null;
    let receipt=lookup;
    if(!receipt&&delivery.kind==='created')receipt=await hubAdapters.dataStudio.deliverFlowSpec(row.idempotency_key,delivery.delivery) as {status?:string;receiverRef?:string};
    if(!receipt&&delivery.kind==='existing'&&delivery.delivery)receipt=await hubAdapters.dataStudio.deliverFlowSpec(row.idempotency_key,delivery.delivery) as {status?:string;receiverRef?:string};
    if(!receipt)return reply.code(202).send({handoffId:row.handoff_id,status:'unknown',accepted:false});
    if(receipt.status!=='accepted')return reply.code(202).send({handoffId:row.handoff_id,status:'unknown',accepted:false});
    await withTenant(options.pool,current.tenantId,async(client)=>{
      const confirmed=await client.query<{run_id:string|null}>('UPDATE hub.handoffs SET status=\'confirmed\',receiver_ref=$3,confirmed_at=clock_timestamp() WHERE tenant_id=$1 AND handoff_id=$2 AND status IN (\'pending\',\'unknown\') RETURNING run_id',[current.tenantId,row.handoff_id,receipt!.receiverRef]);
      if(confirmed.rows[0]?.run_id){const run=await client.query<{state_version:number}>("UPDATE runs.runs SET state='COMPLETED',state_version=state_version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2 RETURNING state_version",[current.tenantId,confirmed.rows[0].run_id]);const decision=await client.query<{decision_id:string}>('SELECT decision_id FROM runs.authz_decisions WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at DESC LIMIT 1',[current.tenantId,confirmed.rows[0].run_id]);await client.query("INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,decision_id,safe_payload) VALUES($1,$2,2,'run_terminal',$3,$4::jsonb)",[current.tenantId,confirmed.rows[0].run_id,decision.rows[0]!.decision_id,JSON.stringify({state:'COMPLETED',state_version:run.rows[0]!.state_version,receiver_status:'confirmed'})]);}
      await client.query("UPDATE runs.outbox SET sent_at=clock_timestamp() WHERE tenant_id=$1 AND message_id=(SELECT outbox_message_id FROM hub.handoffs WHERE tenant_id=$1 AND handoff_id=$2)",[current.tenantId,row.handoff_id]);
    });
    return reply.send({handoffId:row.handoff_id,status:'confirmed',accepted:true,receiverRef:receipt.receiverRef});
  });
  app.get<{Params:{id:string;handoffId:string}}>('/api/flowspecs/:id/handoff/:handoffId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const found=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{handoff_id:string;idempotency_key:string;payload_hash:string;status:string;receiver_ref:string|null}>('SELECT handoff_id,idempotency_key,payload_hash,status,receiver_ref FROM hub.handoffs WHERE tenant_id=$1 AND flowspec_id=$2 AND handoff_id=$3',[current.tenantId,request.params.id,request.params.handoffId]));
    const row=found.rows[0];if(!row)return reply.code(404).send({error:'handoff_not_found'});if(row.status==='confirmed'||row.status==='reconciled')return reply.send({handoffId:row.handoff_id,status:row.status,accepted:true,receiverRef:row.receiver_ref});
    const receipt=await hubAdapters.dataStudio.lookupFlowSpec(row.idempotency_key) as {status?:string;receiverRef?:string}|null;
    if(receipt?.status==='accepted'){await withTenant(options.pool,current.tenantId,async(client)=>{const reconciled=await client.query<{run_id:string|null}>('UPDATE hub.handoffs SET status=\'reconciled\',receiver_ref=$3,confirmed_at=clock_timestamp() WHERE tenant_id=$1 AND handoff_id=$2 AND status IN (\'pending\',\'unknown\') RETURNING run_id',[current.tenantId,row.handoff_id,receipt.receiverRef]);if(reconciled.rows[0]?.run_id){const run=await client.query<{state_version:number}>("UPDATE runs.runs SET state='COMPLETED',state_version=state_version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2 RETURNING state_version",[current.tenantId,reconciled.rows[0].run_id]);const decision=await client.query<{decision_id:string}>('SELECT decision_id FROM runs.authz_decisions WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at DESC LIMIT 1',[current.tenantId,reconciled.rows[0].run_id]);await client.query("INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,decision_id,safe_payload) VALUES($1,$2,2,'run_terminal',$3,$4::jsonb)",[current.tenantId,reconciled.rows[0].run_id,decision.rows[0]!.decision_id,JSON.stringify({state:'COMPLETED',state_version:run.rows[0]!.state_version,receiver_status:'reconciled'})]);}});return reply.send({handoffId:row.handoff_id,status:'reconciled',accepted:true,receiverRef:receipt.receiverRef});}
    await withTenant(options.pool,current.tenantId,(client)=>client.query("UPDATE hub.handoffs SET status='unknown' WHERE tenant_id=$1 AND handoff_id=$2 AND status='pending'",[current.tenantId,row.handoff_id]));return reply.code(202).send({handoffId:row.handoff_id,status:'unknown',accepted:false});
  });
  app.get('/api/hub/adapters',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const adapters=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{product:string;connected:boolean;version:number;capabilities:string[];updated_at:Date}>(
      `SELECT a.product,a.connected,a.current_version AS version,v.capabilities,a.updated_at FROM hub.adapters a JOIN hub.adapter_versions v ON v.tenant_id=a.tenant_id AND v.product=a.product AND v.version=a.current_version WHERE a.tenant_id=$1 ORDER BY a.product`,[current.tenantId]));
    return reply.send({adapters:adapters.rows.map(({updated_at,...adapter})=>({...adapter,updatedAt:updated_at.toISOString()}))});
  });
  app.post<{Params:{product:string}}>('/api/hub/adapters/:product/connect',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!['data_studio','semantics'].includes(request.params.product))return reply.code(404).send({error:'hub_adapter_not_found'});
    const changed=await withTenant(options.pool,current.tenantId,async(client)=>client.query('UPDATE hub.adapters SET connected=true,updated_at=clock_timestamp() WHERE tenant_id=$1 AND product=$2 RETURNING product,connected,current_version AS version',[current.tenantId,request.params.product]));
    if(!changed.rowCount)return reply.code(404).send({error:'hub_adapter_not_found'});return reply.send({adapter:changed.rows[0]});
  });
  app.post<{Params:{product:string}}>('/api/hub/adapters/:product/disconnect',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!['data_studio','semantics'].includes(request.params.product))return reply.code(404).send({error:'hub_adapter_not_found'});
    const changed=await withTenant(options.pool,current.tenantId,async(client)=>client.query('UPDATE hub.adapters SET connected=false,updated_at=clock_timestamp() WHERE tenant_id=$1 AND product=$2 RETURNING product,connected,current_version AS version',[current.tenantId,request.params.product]));
    if(!changed.rowCount)return reply.code(404).send({error:'hub_adapter_not_found'});return reply.send({adapter:changed.rows[0]});
  });
  app.get('/api/semantics/metrics',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{metric_id:string;name:string;description:string;dimensions:string[];unit:string;certified:boolean;adapter_version:number}>(
      `SELECT m.metric_id,m.name,m.description,m.dimensions,m.unit,m.certified,m.adapter_version FROM hub.certified_metrics m
       JOIN hub.adapters a ON a.tenant_id=m.tenant_id AND a.product=m.adapter_product AND a.connected AND a.current_version=m.adapter_version
       WHERE m.tenant_id=$1 ORDER BY m.name`,[current.tenantId]));
    return reply.send({metrics:result.rows.map((metric)=>({metricId:metric.metric_id,name:metric.name,description:metric.description,dimensions:metric.dimensions,unit:metric.unit,certified:metric.certified,adapterVersion:metric.adapter_version}))});
  });
  app.post<{Params:{metricId:string}}>('/api/semantics/metrics/:metricId/query',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!/^[a-z][a-z0-9_]{0,99}$/.test(request.params.metricId))return reply.code(400).send({error:'invalid_metric_id'});
    const metric=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{metric_id:string;adapter_id:string;adapter_version:number;name:string;unit:string;source_asset:string;adapter_connected:boolean;adapter_current_version:number}>(
      `SELECT m.metric_id,a.adapter_id,m.adapter_version,m.name,m.unit,m.source_asset,a.connected AS adapter_connected,a.current_version AS adapter_current_version
       FROM hub.certified_metrics m JOIN hub.adapters a ON a.tenant_id=m.tenant_id AND a.product=m.adapter_product
       WHERE m.tenant_id=$1 AND m.metric_id=$2 AND m.certified`,[current.tenantId,request.params.metricId]));
    const selected=metric.rows[0];if(!selected)return reply.code(404).send({error:'certified_metric_not_found'});
    if(!selected.adapter_connected||!hubAdapters.semantics.connected)return reply.code(503).send({error:'hub_adapter_disconnected'});
    if(selected.adapter_current_version!==selected.adapter_version||selected.adapter_current_version!==hubAdapters.semantics.version)return reply.code(409).send({error:'semantic_adapter_version_changed'});
    const decision=await authorise(options.pool,{principal:{tenant_id:current.tenantId,principal_id:current.userId,kind:'user',roles:[],groups:[],attributes:{}},capability_id:'semantics.metric.read',resources:[selected.metric_id],purpose:'certified_metric_query',environment:'production'});
    if(decision.outcome!=='allow')return reply.code(403).send({error:'metric_not_authorized'});
    let answerResult;
    try{answerResult=await hubAdapters.semantics.queryCertifiedMetric(selected.metric_id);}
    catch(error){if(error instanceof Error&&error.message==='hub_adapter_disconnected')return reply.code(503).send({error:error.message});if(error instanceof Error&&error.message==='unknown_certified_metric')return reply.code(404).send({error:'certified_metric_not_found'});throw error;}
    const runId=randomUUID();const claimId=randomUUID();const evidenceId=randomUUID();
    const evidence=EvidenceRefSchema.parse({evidence_id:evidenceId,kind:'api_call',source_id:selected.adapter_id,asset_ids:[],locator:`hub://semantics/metrics/${selected.metric_id}`,content_hash:answerResult.evidence.contentHash,captured_at:new Date().toISOString(),collector_version:`semantics-v${answerResult.adapterVersion}`,redacted_summary:`Certified metric ${selected.metric_id} returned by Semantics`});
    const claim=ClaimSchema.parse({claim_id:claimId,kind:'metric',statement:`Certified metric ${answerResult.name}: ${answerResult.value} ${answerResult.unit}`,evidence_ids:[evidence.evidence_id]});
    const answer={metric:answerResult.metricId,bySource:[{sourceId:selected.adapter_id,connectorType:'semantics',value:answerResult.value}],claims:[claim],evidence:[evidence],trust:{groupCount:1,sourceCount:1,joins:['group']},metricDefinition:{name:answerResult.name,unit:answerResult.unit,certified:answerResult.certified,adapter:'semantics',adapterVersion:answerResult.adapterVersion}};
    try{
      const committed=await withTenant(options.pool,current.tenantId,async(client)=>{
        const currentMetric=await client.query<{connected:boolean;current_version:number;adapter_version:number;entitled:boolean;capability_enabled:boolean}>(
          `SELECT a.connected,a.current_version,m.adapter_version,
             EXISTS(SELECT 1 FROM core.entitlements e WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.capability_id='semantics.metric.read' AND e.allowed AND (e.resource_id IS NULL OR e.resource_id=m.metric_id)) AS entitled,
             EXISTS(SELECT 1 FROM registry.capabilities c WHERE c.tenant_id=$1 AND c.capability_id='semantics.metric.read' AND c.effect_class='READ' AND c.enabled AND c.active_version=1) AS capability_enabled
           FROM hub.certified_metrics m JOIN hub.adapters a ON a.tenant_id=m.tenant_id AND a.product=m.adapter_product WHERE m.tenant_id=$1 AND m.metric_id=$3 FOR SHARE OF a,m`,[current.tenantId,current.userId,selected.metric_id]);
        const row=currentMetric.rows[0];if(!row||!row.connected||row.current_version!==row.adapter_version)throw new Error('semantic_adapter_version_changed');
        if(!row.capability_enabled||!row.entitled){
          await client.query(`INSERT INTO runs.authz_decisions(tenant_id,principal_id,capability_id,outcome,policy_version,reasons)
            VALUES($1,$2,'semantics.metric.read','deny','phase4-v1','["authorization_revoked_before_execution"]')`,[current.tenantId,current.userId]);
          return false;
        }
        await client.query(`INSERT INTO runs.runs(tenant_id,run_id,principal_id,state) VALUES($1,$2,$3,'CREATED')`,[current.tenantId,runId,current.userId]);
        const authz=await client.query<{decision_id:string}>(`INSERT INTO runs.authz_decisions(tenant_id,run_id,principal_id,capability_id,outcome,policy_version,reasons)
          VALUES($1,$2,$3,'semantics.metric.read','allow','phase4-v1','["certified_metric_entitled"]') RETURNING decision_id`,[current.tenantId,runId,current.userId]);
        let sequence=0;
        const event=async(type:string,payload:Record<string,unknown>,decisionId?:string)=>{
          sequence+=1;await client.query(`INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,decision_id,safe_payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[current.tenantId,runId,sequence,type,decisionId??authz.rows[0]!.decision_id,JSON.stringify(payload)]);
        };
        await event('run_created',{state:'CREATED',state_version:0});
        for(const [state,type] of [['PLANNING','run_state_changed'],['PLAN_VALIDATED','plan_validated'],['RUNNING','run_state_changed']] as const){
          const next=await client.query<{state_version:number}>(`UPDATE runs.runs SET state=$3,state_version=state_version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2 RETURNING state_version`,[current.tenantId,runId,state]);
          await event(type,{state,state_version:next.rows[0]!.state_version,count:1,capability_id:'semantics.metric.read',capability_version:1});
        }
        await client.query(`INSERT INTO hub.metric_results(tenant_id,run_id,metric_id,adapter_version,result_value,unit,evidence_metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[current.tenantId,runId,selected.metric_id,answerResult.adapterVersion,answerResult.value,answerResult.unit,JSON.stringify(evidence)]);
        await client.query(`INSERT INTO runs.analytic_answers(tenant_id,run_id,status,answer) VALUES($1,$2,'COMPLETED',$3::jsonb)`,[current.tenantId,runId,JSON.stringify(answer)]);
        await event('evidence_added',{result_ref:`hub://semantics/${runId}/${selected.metric_id}`,result_classification:'AGGREGATE',capability_id:'semantics.metric.read',capability_version:1});
        for(const state of ['FINALISING','COMPLETED'] as const){
          const next=await client.query<{state_version:number}>(`UPDATE runs.runs SET state=$3,state_version=state_version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2 RETURNING state_version`,[current.tenantId,runId,state]);
          await event(state==='COMPLETED'?'run_terminal':'run_state_changed',{state,state_version:next.rows[0]!.state_version});
        }
        return true;
      });
      if(!committed)return reply.code(403).send({error:'metric_not_authorized'});
    }catch(error){const code=error instanceof Error?error.message:'certified_metric_query_failed';if(code==='metric_not_authorized')return reply.code(403).send({error:code});if(code==='semantic_adapter_version_changed')return reply.code(409).send({error:code});throw error;}
    return reply.code(201).send({runId,state:'COMPLETED',trustRoute:'certified_metric',answer});
  });
  app.get('/api/metadata/sources',async(request,reply)=>{
    if(!await authenticatedSession(request))return reply.code(401).send({error:'unauthorized'});
    return reply.send({sources:(options.testSources??[]).filter(source=>['dbt','tableau','power_bi'].includes(source.type))});
  });
  app.post<{Body:{sourceId?:string}}>('/api/metadata/connections',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const source=(options.testSources??[]).find((item)=>['dbt','tableau','power_bi'].includes(item.type)&&item.id===request.body?.sourceId);if(!source)return reply.code(400).send({error:'metadata_source_not_found'});
    const connection=await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([current.tenantId,source.id])]);
      const existing=await client.query<{connection_id:string;status:'draft'|'active'}>(
        `SELECT connection_id,status FROM registry.connections WHERE tenant_id=$1 AND connector_type=$2 AND source_ref=$3 AND status IN ('active','draft')
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,created_at DESC LIMIT 1 FOR UPDATE`,
        [current.tenantId,source.type,source.id]);
      if(existing.rows[0])return existing.rows[0];
      const created=await client.query<{connection_id:string;status:'draft'}>(
        `INSERT INTO registry.connections(tenant_id,connector_type,status,source_ref) VALUES($1,$2,'draft',$3) RETURNING connection_id,status`,
        [current.tenantId,source.type,source.id]);
      return created.rows[0]!;
    });
    return reply.code(201).send({connectionId:connection.connection_id,connectorType:source.type,status:connection.status});
  });
  app.post<{Params:{connectionId:string}}>('/api/metadata/connections/:connectionId/activate',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const draft=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{source_ref:string|null;connector_type:string;status:string}>(
      'SELECT source_ref,connector_type,status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2',[current.tenantId,request.params.connectionId]));
    const row=draft.rows[0];if(!row||!row.source_ref)return reply.code(404).send({error:'metadata_connection_not_found'});
    const valid=(options.testSources??[]).some(source=>source.id===row.source_ref&&source.type===row.connector_type);
    if(!valid)return reply.code(400).send({error:'metadata_connection_mismatch'});
    if(row.status==='active')return reply.send({connectionId:request.params.connectionId,status:'active',connectorType:row.connector_type});
    if(row.status!=='draft')return reply.code(404).send({error:'metadata_connection_not_found'});
    const connection=await activateConnection(options.pool,{tenantId:current.tenantId,principalId:current.userId,connectorType:row.connector_type as ConnectorType,connectionId:request.params.connectionId,sourceRef:row.source_ref});
    return reply.send({connectionId:connection.connectionId,status:'active',connectorType:row.connector_type});
  });
  app.post<{Params:{connectionId:string};Body:{manifest?:unknown;sourceConnectionId?:string}}>('/api/metadata/import/:connectionId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(request.body?.manifest&&typeof request.body.sourceConnectionId==='string'){
      try{return reply.send(await importDbtManifest(options.pool,{tenantId:current.tenantId,connectionId:request.params.connectionId,sourceConnectionId:request.body.sourceConnectionId,manifest:request.body.manifest}));}
      catch(error){const code=error instanceof Error?error.message:'dbt_manifest_import_failed';if(code==='invalid_dbt_manifest')return reply.code(400).send({error:code});if(code==='dbt_connection_not_found')return reply.code(404).send({error:code});throw error;}
    }
    return reply.code(400).send({error:'metadata_file_required'});
  });
  app.get<{Querystring:{assetId?:string;direction?:'upstream'|'downstream'|'both';asOf?:string}}>('/api/lineage',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const {assetId,direction='both',asOf}=request.query;
    if(!assetId||!['upstream','downstream','both'].includes(direction)|| (asOf!==undefined&&!Number.isFinite(Date.parse(asOf))))return reply.code(400).send({error:'invalid_lineage_query'});
    return reply.send(await queryLineage(options.pool,{tenantId:current.tenantId,assetId,direction,...(asOf?{asOf:new Date(asOf)}:{})}));
  });
  app.get('/api/ids',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    return reply.send({fields:await listIdentifierFields(options.pool,current.tenantId)});
  });
  app.get('/api/reports',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    return reply.send({reports:await listReports(options.pool,current.tenantId)});
  });
  app.get('/api/lineage/assertions',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    return reply.send({assertions:await listGraphAssertions(options.pool,current.tenantId)});
  });
  app.get('/api/lineage/assets',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    return reply.send({assets:await listGraphAssets(options.pool,current.tenantId)});
  });
  app.get<{Params:{assetId:string}}>('/api/lineage/:assetId/impact',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!/^[0-9a-f-]{36}$/i.test(request.params.assetId))return reply.code(400).send({error:'invalid_asset_id'});
    return reply.send(await getImpactRadius(options.pool,{tenantId:current.tenantId,assetId:request.params.assetId}));
  });
  app.get('/api/lineage/snapshots',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    return reply.send({snapshots:await listGraphSnapshots(options.pool,current.tenantId)});
  });
  app.get<{Params:{from:string;to:string}}>('/api/lineage/snapshots/:from/compare/:to',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!/^[0-9a-f-]{36}$/i.test(request.params.from)||!/^[0-9a-f-]{36}$/i.test(request.params.to))return reply.code(400).send({error:'invalid_snapshot_id'});
    try{return reply.send(await compareGraphSnapshots(options.pool,{tenantId:current.tenantId,fromSnapshotId:request.params.from,toSnapshotId:request.params.to}));}
    catch(error){if(error instanceof Error&&error.message==='snapshot_not_found')return reply.code(404).send({error:error.message});throw error;}
  });
  app.get<{Params:{assetId:string}}>('/api/ids/:assetId/path',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!/^[0-9a-f-]{36}$/i.test(request.params.assetId))return reply.code(400).send({error:'invalid_asset_id'});
    return reply.send(await getIdentifierPath(options.pool,{tenantId:current.tenantId,assetId:request.params.assetId}));
  });
  app.post<{Params:{assetId:string};Body:{value?:string}}>('/api/ids/:assetId/trace',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!/^[0-9a-f-]{36}$/i.test(request.params.assetId)||typeof request.body?.value!=='string'||request.body.value.length<1||request.body.value.length>256)return reply.code(400).send({error:'invalid_identifier_request'});
    const key=process.env.ARTIFACT_MASTER_KEY;
    if(!key)return reply.code(503).send({error:'identifier_trace_unavailable'});
    try{return reply.send({matches:await traceIdentifier(options.pool,{tenantId:current.tenantId,assetId:request.params.assetId,value:request.body.value,masterKey:Buffer.from(key,'base64')})});}
    catch(error){if(error instanceof Error&&error.message==='invalid_identifier_input')return reply.code(503).send({error:'identifier_trace_unavailable'});throw error;}
  });
  app.post<{Params:{assertionId:string};Body:{status?:string}}>('/api/lineage/assertions/:assertionId/review',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!['accepted','disputed','rejected'].includes(request.body?.status??''))return reply.code(400).send({error:'invalid_review_status'});
    try{return reply.send(await reviewGraphAssertion(options.pool,{tenantId:current.tenantId,principalId:current.userId,assertionId:request.params.assertionId,status:request.body!.status as 'accepted'|'disputed'|'rejected'}));}
    catch(error){if(error instanceof Error&&error.message==='assertion_not_found')return reply.code(404).send({error:error.message});throw error;}
  });
  app.post<{Params:{assertionId:string};Body:{runId?:string}}>('/api/lineage/assertions/:assertionId/verify',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(typeof request.body?.runId!=='string'||!/^[0-9a-f-]{36}$/i.test(request.body.runId))return reply.code(400).send({error:'invalid_run_id'});
    try{return reply.send(await verifyAssertionFromRun(options.pool,{tenantId:current.tenantId,assertionId:request.params.assertionId,runId:request.body.runId}));}
    catch(error){const code=error instanceof Error?error.message:'lineage_verification_failed';if(code==='assertion_not_found')return reply.code(404).send({error:code});if(code==='exact_successful_run_pair_not_found')return reply.code(409).send({error:code});throw error;}
  });
  app.post<{Params:{assertionId:string};Body:{evidenceId?:string}}>('/api/lineage/assertions/:assertionId/reconcile',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(typeof request.body?.evidenceId!=='string'||!/^[0-9a-f-]{36}$/i.test(request.body.evidenceId))return reply.code(400).send({error:'invalid_evidence_id'});
    try{return reply.send(await reconcileAssertion(options.pool,{tenantId:current.tenantId,assertionId:request.params.assertionId,evidenceId:request.body.evidenceId}));}
    catch(error){if(error instanceof Error&&error.message==='reconciliation_evidence_not_found')return reply.code(409).send({error:error.message});throw error;}
  });
  app.post<{Body:{tenantId?:string;email?:string;password?:string}}>('/api/auth/login',async(request,reply)=>{
    const rawEmail=request.body?.email;const password=request.body?.password;
    if(typeof rawEmail!=='string'||typeof password!=='string'||password.length>1024)return reply.code(400).send({error:'invalid_credentials'});
    const email=rawEmail.trim().toLowerCase();if(!email||email.length>254||!password)return reply.code(400).send({error:'invalid_credentials'});
    const tenantId=typeof request.body?.tenantId==='string'?request.body.tenantId.trim():'';
    const legacyAccount=!tenantId?options.testAccounts?.find(item=>item.email.toLowerCase()===email):undefined;
    const scopedTenantId=tenantId||legacyAccount?.tenantId;
    if(!scopedTenantId)return reply.code(401).send({error:'invalid_credentials'});
    const token=randomBytes(32).toString('base64url');const sessionId=randomUUID();
    const user=await withTenant(options.pool,scopedTenantId,async(client)=>{
      const result=await client.query<{user_id:string;password_hash:string;is_active:boolean;display_name:string}>(
        'SELECT user_id,password_hash,is_active,display_name FROM core.users WHERE tenant_id=$1 AND email=$2',[scopedTenantId,email]);
      const row=result.rows[0];if(!row||!row.is_active||!verifyPassword(password,row.password_hash))return null;
      await client.query(`INSERT INTO core.sessions(tenant_id,session_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,clock_timestamp()+interval '8 hours')`,[scopedTenantId,sessionId,row.user_id,digest(token)]);
      await client.query(`INSERT INTO core.activity_events(tenant_id,event_type,principal_id) VALUES($1,'user_active',$2)`,[scopedTenantId,row.user_id]);
      return row;
    });
    if(!user)return reply.code(401).send({error:'invalid_credentials'});
    const payload=Buffer.from(JSON.stringify({tenantId:scopedTenantId,userId:user.user_id,sessionId,token})).toString('base64url');
    const cookie=`${payload}.${sign(payload,options.sessionSecret)}`;
    reply.header('set-cookie',`si_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs/1000}`);
    return reply.send({user:{email,displayName:user.display_name}});
  });
  async function session(request: {headers:Record<string,string|string[]|undefined>}):Promise<{tenantId:string;userId:string;sessionId:string;token:string}|null>{
    const cookieHeader=request.headers.cookie;if(!cookieHeader||Array.isArray(cookieHeader))return null;
    const cookie=cookieHeader.split(';').map(part=>part.trim()).find(part=>part.startsWith('si_session='))?.slice('si_session='.length);
    if(!cookie)return null;const [payload,signature]=cookie.split('.');if(!payload||!signature)return null;
    const expected=Buffer.from(sign(payload,options.sessionSecret));const actual=Buffer.from(signature);
    if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return null;
    try{return JSON.parse(Buffer.from(payload,'base64url').toString()) as {tenantId:string;userId:string;sessionId:string;token:string};}catch{return null;}
  }
  async function authenticatedSession(request:{headers:Record<string,string|string[]|undefined>}):Promise<{tenantId:string;userId:string;sessionId:string;token:string}|null>{
    const current=await session(request);if(!current)return null;
    const valid=await withTenant(options.pool,current.tenantId,async(client)=>{
      const result=await client.query('SELECT 1 FROM core.sessions WHERE session_id=$1 AND user_id=$2 AND token_hash=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
        [current.sessionId,current.userId,digest(current.token)]);return Boolean(result.rowCount);
    });
    return valid?current:null;
  }
  app.get('/api/auth/me',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const user=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{email:string;display_name:string}>('SELECT email,display_name FROM core.users WHERE tenant_id=$1 AND user_id=$2',[current.tenantId,current.userId]));
    const row=user.rows[0];if(!row)return reply.code(401).send({error:'unauthorized'});
    return reply.send({user:{email:row.email,displayName:row.display_name}});
  });
  app.post<{Body:{email?:unknown}}>('/api/tenant/invites',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const admin=await withTenant(options.pool,current.tenantId,client=>client.query("SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='tenant.admin' AND allowed AND resource_id IS NULL LIMIT 1",[current.tenantId,current.userId]));
    if(!admin.rowCount)return reply.code(403).send({error:'tenant_admin_required'});
    if(typeof request.body?.email!=='string')return reply.code(400).send({error:'invite_email_invalid'});
    const email=request.body.email.trim().toLowerCase();if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return reply.code(400).send({error:'invite_email_invalid'});
    const token=randomBytes(32).toString('base64url');const tokenHash=digest(token);
    const invite=await withTenant(options.pool,current.tenantId,async(client)=>{
      const existing=await client.query('SELECT 1 FROM core.users WHERE tenant_id=$1 AND email=$2',[current.tenantId,email]);if(existing.rowCount)return null;
      const created=await client.query<{invite_id:string;expires_at:Date}>(`INSERT INTO core.tenant_invites(tenant_id,email,token_hash,expires_at,created_by)
        VALUES($1,$2,$3,clock_timestamp()+interval '24 hours',$4) RETURNING invite_id,expires_at`,[current.tenantId,email,tokenHash,current.userId]);
      await client.query("INSERT INTO core.activity_events(tenant_id,event_type,principal_id) VALUES($1,'member_invited',$2)",[current.tenantId,current.userId]);
      return created.rows[0]!;
    });
    if(!invite)return reply.code(409).send({error:'invite_email_already_in_workspace'});
    const publicUrl=new URL(process.env.PUBLIC_APP_URL??'http://localhost:5173');publicUrl.pathname='/invite';publicUrl.search='';publicUrl.searchParams.set('tenant',current.tenantId);publicUrl.searchParams.set('token',token);
    return reply.code(201).send({inviteId:invite.invite_id,inviteUrl:publicUrl.toString(),expiresAt:invite.expires_at});
  });
  app.post<{Body:{tenantId?:unknown;token?:unknown;displayName?:unknown;password?:unknown}}>('/api/auth/invites/accept',async(request,reply)=>{
    const tenantId=typeof request.body?.tenantId==='string'?request.body.tenantId.trim():'';
    const token=typeof request.body?.token==='string'?request.body.token:'';
    const displayName=typeof request.body?.displayName==='string'?request.body.displayName.trim():'';
    const password=typeof request.body?.password==='string'?request.body.password:'';
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tenantId)||!/^[a-zA-Z0-9_-]{40,64}$/.test(token)||!displayName||displayName.length>120||password.length<12||password.length>1024)return reply.code(400).send({error:'invite_acceptance_invalid'});
    const accepted=await withTenant(options.pool,tenantId,async(client)=>{
      const found=await client.query<{invite_id:string;email:string}>('SELECT invite_id,email FROM core.tenant_invites WHERE tenant_id=$1 AND token_hash=$2 AND accepted_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',[tenantId,digest(token)]);
      const invite=found.rows[0];if(!invite)return null;
      const created=await client.query<{user_id:string}>(`INSERT INTO core.users(tenant_id,email,display_name,password_hash) VALUES($1,$2,$3,$4)
        ON CONFLICT (tenant_id,email) DO NOTHING RETURNING user_id`,[tenantId,invite.email,displayName,hashPassword(password)]);
      const userId=created.rows[0]?.user_id;if(!userId)return null;
      await client.query('UPDATE core.tenant_invites SET accepted_at=clock_timestamp(),accepted_by=$3 WHERE tenant_id=$1 AND invite_id=$2',[tenantId,invite.invite_id,userId]);
      await client.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,allowed) VALUES($1,$2,'tenant.member',true)",[tenantId,userId]);
      await client.query("INSERT INTO core.activity_events(tenant_id,event_type,principal_id) VALUES($1,'member_joined',$2)",[tenantId,userId]);
      return {email:invite.email,displayName};
    });
    if(!accepted)return reply.code(400).send({error:'invite_invalid_or_expired'});
    return reply.code(201).send({user:accepted});
  });
  app.get('/api/tenant/sso',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,client=>client.query<{issuer:string;client_id:string;client_secret_ref:string;allowed_email_domains:string[];enabled:boolean}>(
      'SELECT issuer,client_id,client_secret_ref,allowed_email_domains,enabled FROM core.oidc_providers WHERE tenant_id=$1',[current.tenantId]));
    const row=result.rows[0];return reply.send({provider:row?{issuer:row.issuer,clientId:row.client_id,clientSecretRef:row.client_secret_ref,allowedEmailDomains:row.allowed_email_domains,enabled:row.enabled}:null});
  });
  app.post<{Body:{issuer?:unknown;clientId?:unknown;clientSecretRef?:unknown;allowedEmailDomains?:unknown;enabled?:unknown}}>('/api/tenant/sso',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const admin=await withTenant(options.pool,current.tenantId,client=>client.query(
      "SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='tenant.sso.configure' AND allowed AND resource_id IS NULL LIMIT 1",[current.tenantId,current.userId]));
    if(!admin.rowCount)return reply.code(403).send({error:'tenant_admin_required'});
    const body=request.body;
    if(typeof body.issuer!=='string'||typeof body.clientId!=='string'||typeof body.clientSecretRef!=='string'||!Array.isArray(body.allowedEmailDomains)||body.allowedEmailDomains.some(domain=>typeof domain!=='string')||(body.enabled!==undefined&&typeof body.enabled!=='boolean'))return reply.code(400).send({error:'invalid_sso_configuration'});
    let issuer:string;try{const parsed=new URL(body.issuer);if(parsed.protocol!=='https:'||parsed.search||parsed.hash)throw new Error();issuer=parsed.toString();}catch{return reply.code(400).send({error:'invalid_sso_issuer'});}
    const clientId=body.clientId.trim(),secretRef=body.clientSecretRef.trim();
    const domains=(body.allowedEmailDomains as string[]).map(domain=>domain.trim().toLowerCase());
    if(!clientId||clientId.length>255||!/^[A-Z][A-Z0-9_]{2,127}$/.test(secretRef)||domains.length<1||domains.length>20||domains.some(domain=>!/^[a-z0-9.-]+\.[a-z]{2,63}$/.test(domain)))return reply.code(400).send({error:'invalid_sso_configuration'});
    const enabled=body.enabled!==false;
    await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query(`INSERT INTO core.oidc_providers(tenant_id,issuer,client_id,client_secret_ref,allowed_email_domains,enabled)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id) DO UPDATE SET issuer=EXCLUDED.issuer,client_id=EXCLUDED.client_id,client_secret_ref=EXCLUDED.client_secret_ref,allowed_email_domains=EXCLUDED.allowed_email_domains,enabled=EXCLUDED.enabled,updated_at=clock_timestamp()`,
      [current.tenantId,issuer,clientId,secretRef,domains,enabled]);
      await client.query("INSERT INTO core.activity_events(tenant_id,event_type,principal_id,sso_provider_id) SELECT $1,'sso_provider_configured',$2,provider_id FROM core.oidc_providers WHERE tenant_id=$1",[current.tenantId,current.userId]);
    });
    return reply.send({enabled,issuer,clientId,clientSecretRef:secretRef,allowedEmailDomains:domains});
  });
  app.get<{Params:{tenantId:string}}>('/api/auth/oidc/:tenantId/start',async(request,reply)=>{
    const tenantId=request.params.tenantId;
    if(!/^[a-zA-Z0-9_-]{3,128}$/.test(tenantId))return reply.code(404).send({error:'oidc_provider_not_found'});
    const result=await withTenant(options.pool,tenantId,client=>client.query<{provider_id:string;issuer:string;client_id:string;enabled:boolean}>(
      'SELECT provider_id,issuer,client_id,enabled FROM core.oidc_providers WHERE tenant_id=$1',[tenantId]));
    const provider=result.rows[0];if(!provider?.enabled)return reply.code(404).send({error:'oidc_provider_not_found'});
    const redirectUri=process.env.OIDC_REDIRECT_URI;if(!redirectUri)return reply.code(503).send({error:'oidc_redirect_uri_required'});
    try{
      const discoveryUrl=`${provider.issuer.replace(/\/$/,'')}/.well-known/openid-configuration`;
      const discovery=await oidcDocument(oidcFetch,discoveryUrl);
      if(discovery.issuer!==provider.issuer)return reply.code(503).send({error:'oidc_provider_unavailable'});
      const authorizationEndpoint=oidcEndpoint(discovery.authorization_endpoint);
      const requestData=createOidcAuthorizationRequest({authorizationEndpoint,clientId:provider.client_id,redirectUri});
      const expiresAt=Date.now()+5*60_000;
      const statePayload=Buffer.from(JSON.stringify({tenantId,providerId:provider.provider_id,state:requestData.state,nonce:requestData.nonce,codeVerifier:requestData.codeVerifier,expiresAt})).toString('base64url');
      const cookie=`si_oidc=${statePayload}.${sign(statePayload,options.sessionSecret)}; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=300; Secure`;
      await withTenant(options.pool,tenantId,client=>client.query('INSERT INTO core.oidc_login_states(tenant_id,state_hash,provider_id,expires_at) VALUES($1,$2,$3,to_timestamp($4/1000.0))',[tenantId,digest(requestData.state),provider.provider_id,expiresAt]));
      return reply.header('set-cookie',cookie).redirect(requestData.authorizationUrl,302);
    }catch{return reply.code(503).send({error:'oidc_provider_unavailable'});}
  });
  app.get<{Querystring:{code?:string;state?:string;error?:string}}>('/api/auth/oidc/callback',async(request,reply)=>{
    const rawCookie=cookieValue(request.headers.cookie,'si_oidc');
    if(!rawCookie||request.query.error||!request.query.code||!request.query.state||request.query.code.length>4096||request.query.state.length>256)return reply.code(400).send({error:'oidc_callback_invalid'});
    const [encoded,signature]=rawCookie.split('.');if(!encoded||!signature||!secureEqual(sign(encoded,options.sessionSecret),signature))return reply.code(400).send({error:'oidc_callback_invalid'});
    let state:{tenantId:string;providerId:string;state:string;nonce:string;codeVerifier:string;expiresAt:number};
    try{state=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')) as typeof state;}catch{return reply.code(400).send({error:'oidc_callback_invalid'});}
    if(!state.tenantId||!state.providerId||!state.state||!state.nonce||!state.codeVerifier||state.expiresAt<=Date.now()||!secureEqual(state.state,request.query.state))return reply.code(400).send({error:'oidc_callback_invalid'});
    const claim=await withTenant(options.pool,state.tenantId,client=>client.query<{provider_id:string}>(
      'UPDATE core.oidc_login_states SET consumed_at=clock_timestamp() WHERE tenant_id=$1 AND state_hash=$2 AND provider_id=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING provider_id',[state.tenantId,digest(state.state),state.providerId]));
    if(!claim.rowCount)return reply.code(400).send({error:'oidc_callback_invalid'});
    try{
      const providerResult=await withTenant(options.pool,state.tenantId,client=>client.query<{issuer:string;client_id:string;client_secret_ref:string;allowed_email_domains:string[];enabled:boolean}>(
        'SELECT issuer,client_id,client_secret_ref,allowed_email_domains,enabled FROM core.oidc_providers WHERE tenant_id=$1 AND provider_id=$2',[state.tenantId,state.providerId]));
      const provider=providerResult.rows[0];if(!provider?.enabled)throw new Error('oidc_provider_not_found');
      const redirectUri=process.env.OIDC_REDIRECT_URI;if(!redirectUri)throw new Error('oidc_redirect_uri_required');
      const discovery=await oidcDocument(oidcFetch,`${provider.issuer.replace(/\/$/,'')}/.well-known/openid-configuration`);
      if(discovery.issuer!==provider.issuer)throw new Error('oidc_provider_unavailable');
      const tokenEndpoint=oidcEndpoint(discovery.token_endpoint),jwksUri=oidcEndpoint(discovery.jwks_uri);
      const clientSecret=process.env[provider.client_secret_ref];if(!clientSecret)throw new Error('oidc_client_secret_unavailable');
      const tokenBody=new URLSearchParams({grant_type:'authorization_code',code:request.query.code,redirect_uri:redirectUri,client_id:provider.client_id,code_verifier:state.codeVerifier});
      const tokenResponse=await oidcFetch(tokenEndpoint,{method:'POST',headers:{authorization:`Basic ${Buffer.from(`${provider.client_id}:${clientSecret}`).toString('base64')}`,'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:tokenBody,signal:AbortSignal.timeout(5000)});
      if(!tokenResponse.ok)throw new Error('oidc_token_exchange_failed');
      const tokenJson=await oidcDocument(async()=>tokenResponse,tokenEndpoint);
      if(typeof tokenJson.id_token!=='string')throw new Error('oidc_id_token_missing');
      const jwks=await oidcDocument(oidcFetch,jwksUri);
      if(!Array.isArray(jwks.keys))throw new Error('oidc_jwks_invalid');
      const claims=await verifyOidcIdToken(tokenJson.id_token,{issuer:provider.issuer,audience:provider.client_id,nonce:state.nonce,jwks: jwks as unknown as Parameters<typeof verifyOidcIdToken>[1]['jwks']});
      if(typeof claims.sub!=='string'||!claims.sub||typeof claims.email!=='string'||claims.email_verified!==true)throw new Error('oidc_email_unverified');
      const email=claims.email.trim().toLowerCase(),domain=email.split('@').at(-1)??'';
      if(!provider.allowed_email_domains.includes(domain))throw new Error('oidc_email_domain_denied');
      const subjectHash=oidcSubjectHash(state.tenantId,provider.issuer,claims.sub,options.sessionSecret);
      const user=await withTenant(options.pool,state.tenantId,async(client)=>{
        const existingIdentity=await client.query<{user_id:string}>('SELECT user_id FROM core.external_identities WHERE tenant_id=$1 AND issuer=$2 AND subject_hash=$3',[state.tenantId,provider.issuer,subjectHash]);
        if(existingIdentity.rows[0])return existingIdentity.rows[0];
        const existingUser=await client.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1 AND lower(email)=lower($2) AND is_active',[state.tenantId,email]);
        const matched=existingUser.rows[0];if(!matched)throw new Error('oidc_identity_not_provisioned');
        await client.query('INSERT INTO core.external_identities(tenant_id,issuer,subject_hash,user_id) VALUES($1,$2,$3,$4)',[state.tenantId,provider.issuer,subjectHash,matched.user_id]);return matched;
      });
      const token=randomBytes(32).toString('base64url'),sessionId=randomUUID();
      await withTenant(options.pool,state.tenantId,async(client)=>{
        await client.query("INSERT INTO core.sessions(tenant_id,session_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '8 hours')",[state.tenantId,sessionId,user.user_id,digest(token)]);
        await client.query("INSERT INTO core.activity_events(tenant_id,event_type,principal_id,sso_provider_id) VALUES($1,'sso_login_succeeded',$2,$3)",[state.tenantId,user.user_id,state.providerId]);
      });
      const payload=Buffer.from(JSON.stringify({tenantId:state.tenantId,userId:user.user_id,sessionId,token})).toString('base64url');
      const sessionCookie=`si_session=${payload}.${sign(payload,options.sessionSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs/1000}; Secure`;
      reply.header('set-cookie',[sessionCookie,'si_oidc=; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=0; Secure']);
      return reply.redirect('/',302);
    }catch(error){
      const message=error instanceof Error?error.message:'';
      const safeCode=/^[a-z0-9_]{1,64}$/.test(message)?message:'oidc_login_failed';
      await withTenant(options.pool,state.tenantId,client=>client.query("INSERT INTO core.activity_events(tenant_id,event_type,sso_provider_id,safe_error_code) VALUES($1,'sso_login_failed',$2,$3)",[state.tenantId,state.providerId,safeCode]));
      return reply.code(401).send({error:'oidc_login_failed'});
    }
  });
  app.post('/api/auth/logout',async(request,reply)=>{
    const current=await session(request);if(current)await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query('UPDATE core.sessions SET revoked_at=clock_timestamp() WHERE session_id=$1 AND user_id=$2',[current.sessionId,current.userId]);
    });
    reply.header('set-cookie','si_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return reply.code(204).send();
  });
  app.get('/api/usage',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const from=new Date();from.setUTCDate(1);from.setUTCHours(0,0,0,0);const to=new Date(from);to.setUTCMonth(to.getUTCMonth()+1);
    return reply.send(await getUsage(options.pool,current.tenantId,from,to));
  });
  app.get('/api/tenant/settings',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,client=>client.query<{allow_self_approval:boolean;time_zone:string}>('SELECT allow_self_approval,time_zone FROM core.tenants WHERE tenant_id=$1',[current.tenantId]));
    const row=result.rows[0];if(!row)return reply.code(404).send({error:'tenant_not_found'});
    return reply.send({allowSelfApproval:row.allow_self_approval,timeZone:row.time_zone});
  });
  app.put<{Body:{allowSelfApproval?:unknown;timeZone?:unknown}}>('/api/tenant/settings',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const {allowSelfApproval,timeZone}=request.body??{};
    if(typeof allowSelfApproval!=='boolean'||typeof timeZone!=='string'||timeZone.length>100)return reply.code(400).send({error:'invalid_tenant_settings'});
    try{new Intl.DateTimeFormat('en-US',{timeZone}).format();}catch{return reply.code(400).send({error:'invalid_tenant_time_zone'});}
    const result=await withTenant(options.pool,current.tenantId,client=>client.query<{allow_self_approval:boolean;time_zone:string}>(
      'UPDATE core.tenants SET allow_self_approval=$2,time_zone=$3 WHERE tenant_id=$1 RETURNING allow_self_approval,time_zone',[current.tenantId,allowSelfApproval,timeZone]));
    if(!result.rowCount)return reply.code(404).send({error:'tenant_not_found'});
    return reply.send({allowSelfApproval:result.rows[0]!.allow_self_approval,timeZone:result.rows[0]!.time_zone});
  });
  app.get('/api/me/agent',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const memory=await getPersonalMemory(options.pool,{tenantId:current.tenantId,principalId:current.userId});
    if(memory.defaultSources.length){
      const visible=await withTenant(options.pool,current.tenantId,async(client)=>{
        const active=await client.query<{connection_id:string}>("SELECT connection_id FROM registry.connections WHERE tenant_id=$1 AND status='active' AND connection_id=ANY($2::uuid[])",[current.tenantId,memory.defaultSources]);
        const grants=await client.query<{resource_id:string|null}>("SELECT resource_id FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='analytic.read' AND allowed AND (resource_id IS NULL OR resource_id=ANY($3::text[]))",[current.tenantId,current.userId,memory.defaultSources]);
        const global=grants.rows.some((row)=>row.resource_id===null);return memory.defaultSources.filter((id)=>active.rows.some((row)=>row.connection_id===id)&&(global||grants.rows.some((row)=>row.resource_id===id)));
      });
      memory.defaultSources=visible;
    }
    return reply.send({memory});
  });
  app.put<{Body:Partial<PersonalMemoryData>}>('/api/me/agent',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const body=request.body as Record<string,unknown>|undefined;const allowedKeys=['vocabulary','defaultSources','savedPlanIds','answerStyle','corrections'];
    if(!body||Object.keys(body).some((key)=>!allowedKeys.includes(key)))return reply.code(400).send({error:'invalid_personal_memory'});
    const vocabulary=body.vocabulary??{};const defaultSources=body.defaultSources??[];const savedPlanIds=body.savedPlanIds??[];const corrections=body.corrections??[];const answerStyle=body.answerStyle??null;
    if(!vocabulary||typeof vocabulary!=='object'||Array.isArray(vocabulary)||Object.values(vocabulary).some((value)=>typeof value!=='string')
      ||!Array.isArray(defaultSources)||defaultSources.some((id)=>typeof id!=='string'||! /^[0-9a-f-]{36}$/i.test(id))
      ||!Array.isArray(savedPlanIds)||savedPlanIds.some((id)=>typeof id!=='string'||! /^[0-9a-f-]{36}$/i.test(id))
      ||!Array.isArray(corrections)||corrections.some((item)=>!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='meaning,term'||typeof (item as {term?:unknown}).term!=='string'||typeof (item as {meaning?:unknown}).meaning!=='string')
      ||!([null,'concise','detailed','sql_first','lineage_first'] as unknown[]).includes(answerStyle))return reply.code(400).send({error:'invalid_personal_memory'});
    const permitted=await withTenant(options.pool,current.tenantId,async(client)=>{
      if(!defaultSources.length)return true;
      const active=await client.query<{connection_id:string}>("SELECT connection_id FROM registry.connections WHERE tenant_id=$1 AND status='active' AND connection_id=ANY($2::uuid[])",[current.tenantId,defaultSources]);
      if(active.rowCount!==new Set(defaultSources as string[]).size)return false;
      const grants=await client.query<{resource_id:string|null}>("SELECT resource_id FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='analytic.read' AND allowed AND (resource_id IS NULL OR resource_id=ANY($3::text[]))",[current.tenantId,current.userId,defaultSources]);
      return grants.rows.some((row)=>row.resource_id===null)||(defaultSources as string[]).every((id)=>grants.rows.some((row)=>row.resource_id===id));
    });
    if(!permitted)return reply.code(403).send({error:'default_source_not_authorized'});
    try{const memory={vocabulary:vocabulary as Record<string,string>,defaultSources:defaultSources as string[],savedPlanIds:savedPlanIds as string[],answerStyle:answerStyle as PersonalMemoryData['answerStyle'],corrections:corrections as NonNullable<PersonalMemoryData['corrections']>};await putPersonalMemory(options.pool,{tenantId:current.tenantId,principalId:current.userId,memory});return reply.send({memory});}
    catch(error){if(error instanceof Error&&error.message==='invalid_personal_memory')return reply.code(400).send({error:'invalid_personal_memory'});throw error;}
  });
  app.delete('/api/me/agent',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    return reply.send({deleted:await deletePersonalMemory(options.pool,{tenantId:current.tenantId,principalId:current.userId})});
  });

  app.post<{Body:{question?:string;sourceIds?:string[]}}>('/api/runs',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const question=request.body?.question;const sourceIds=request.body?.sourceIds;
    if(typeof question!=='string'||!question.trim()||!Array.isArray(sourceIds)||sourceIds.length===0||sourceIds.some((id)=>typeof id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))||new Set(sourceIds).size!==sourceIds.length)return reply.code(400).send({error:'invalid_analytic_request'});
    const sources=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{source_id:string;agent_id:string;group_id:string;group_version:number}>(
      `SELECT connection_id AS source_id,connector_agent_id AS agent_id,source_group_id AS group_id,source_group_version AS group_version
       FROM registry.connections WHERE tenant_id=$1 AND status='active' AND connection_id=ANY($2::uuid[])`,[current.tenantId,sourceIds]));
    if(sources.rowCount!==new Set(sourceIds).size)return reply.code(403).send({error:'source_not_active_or_available'});
    try{const plan=await createAnalyticPlan({question,runId:randomUUID(),sources:sources.rows.map((row)=>({sourceId:row.source_id,agentId:row.agent_id,groupId:row.group_id,groupVersion:row.group_version}))});return reply.code(201).send(await startAnalyticRun(options.pool,{tenantId:current.tenantId,principalId:current.userId,plan}));}
    catch(error){const code=error instanceof Error?error.message:'analytic_request_rejected';if(['principal_not_entitled','source_not_active','source_group_version_not_pinned'].includes(code))return reply.code(403).send({error:code});if(code.startsWith('analytic_plan'))return reply.code(400).send({error:code});throw error;}
  });
  app.get<{Params:{runId:string}}>('/api/runs/:runId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{run_id:string;state:string;state_version:number;plan:Record<string,unknown>|null;plan_hash:string|null;answer:Record<string,unknown>|null}>(
      `SELECT r.run_id,r.state,r.state_version,p.plan,p.plan_hash,a.answer FROM runs.runs r LEFT JOIN runs.analytic_plans p USING(tenant_id,run_id)
       LEFT JOIN runs.analytic_answers a USING(tenant_id,run_id)
       WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.run_id=$3`,[current.tenantId,current.userId,request.params.runId]));
    if(!result.rowCount)return reply.code(404).send({error:'run_not_found'});
    const row=result.rows[0]!;const memory=await getPersonalMemory(options.pool,{tenantId:current.tenantId,principalId:current.userId});
    return reply.send({runId:row.run_id,state:row.state,stateVersion:row.state_version,plan:row.plan,planHash:row.plan_hash,answer:row.answer?applyPersonalContext(row.answer as unknown as StructuredAnswer,memory):null});
  });
  app.post<{Params:{runId:string};Body:{format?:ExportFormat}}>('/api/runs/:runId/evidence-pack',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const format=request.body?.format;
    if(!format||!['pdf','xlsx','pptx'].includes(format))return reply.code(400).send({error:'unsupported_export_format'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{plan_hash:string;answer:Record<string,unknown>;state:string}>(
      `SELECT p.plan_hash,a.answer,r.state FROM runs.runs r JOIN runs.analytic_plans p USING(tenant_id,run_id)
       JOIN runs.analytic_answers a USING(tenant_id,run_id)
       WHERE r.tenant_id=$1 AND r.run_id=$2 AND r.principal_id=$3`,[current.tenantId,request.params.runId,current.userId]));
    const row=result.rows[0];if(!row)return reply.code(404).send({error:'run_not_found'});
    if(row.state!=='COMPLETED')return reply.code(409).send({error:'evidence_pack_requires_completed_run'});
    let rendered;
    try{
      const answer=((row.answer as {answer?:unknown}).answer??row.answer) as Parameters<typeof safeEvidencePack>[0]['answer'];
      const pack=safeEvidencePack({runId:request.params.runId,planHash:row.plan_hash,answer});
      rendered=await renderEvidencePack(pack,format);
    }catch(error){if(error instanceof Error&&['evidence_pack_invalid','evidence_pack_sensitive_value'].includes(error.message))return reply.code(422).send({error:error.message});throw error;}
    await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query("SELECT set_config('app.principal_id',$1,true)",[current.userId]);
      await client.query('INSERT INTO reports.export_events(tenant_id,run_id,principal_id,format,content_hash) VALUES($1,$2,$3,$4,$5)',[current.tenantId,request.params.runId,current.userId,format,rendered.contentHash]);
    });
    return reply.type(rendered.contentType).header('content-disposition',`attachment; filename="${rendered.filename}"`).header('x-content-sha256',rendered.contentHash).send(rendered.bytes);
  });
  app.post<{ Params: { runId: string }; Body: { verdict?: 'useful' | 'not_useful'; correction?: { term: string; meaning: string } } }>('/api/runs/:runId/feedback',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const body=request.body;
    if(!body||!['useful','not_useful'].includes(String(body.verdict))||(body.correction&&(Object.keys(body.correction).sort().join(',')!=='meaning,term'||typeof body.correction.term!=='string'||typeof body.correction.meaning!=='string')))return reply.code(400).send({error:'invalid_feedback'});
    try{return reply.code(201).send(await submitFeedback(options.pool,{tenantId:current.tenantId,principalId:current.userId,runId:request.params.runId,verdict:body.verdict!,...(body.correction?{correction:body.correction}:{})}));}
    catch(error){const code=error instanceof Error?error.message:'feedback_failed';if(code==='run_not_found')return reply.code(404).send({error:code});if(code==='unsafe_correction'||code==='correction_not_allowed_for_useful_verdict')return reply.code(400).send({error:code});throw error;}
  });
  app.get('/api/me/saved-questions',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const memory=await getPersonalMemory(options.pool,{tenantId:current.tenantId,principalId:current.userId});
    if(!memory.savedPlanIds.length)return reply.send({questions:[]});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{plan_id:string;plan:Record<string,unknown>;created_at:Date}>(
      `SELECT p.plan->>'plan_id' AS plan_id,p.plan,r.created_at FROM runs.analytic_plans p
       JOIN runs.runs r USING(tenant_id,run_id)
       WHERE p.tenant_id=$1 AND r.principal_id=$2 AND p.plan->>'plan_id'=ANY($3::text[])
       ORDER BY r.created_at DESC`,[current.tenantId,current.userId,memory.savedPlanIds]));
    return reply.send({questions:result.rows.map(row=>({planId:row.plan_id,question:row.plan.question,createdAt:row.created_at.toISOString(),sourceIds:(row.plan.scope as {source_ids:string[]}).source_ids}))});
  });
  app.post<{Params:{planId:string}}>('/api/me/saved-questions/:planId/start',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const memory=await getPersonalMemory(options.pool,{tenantId:current.tenantId,principalId:current.userId});
    if(!memory.savedPlanIds.includes(request.params.planId))return reply.code(404).send({error:'saved_question_not_found'});
    const saved=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{plan:Record<string,unknown>}>(
      `SELECT p.plan FROM runs.analytic_plans p JOIN runs.runs r USING(tenant_id,run_id)
       WHERE p.tenant_id=$1 AND r.principal_id=$2 AND p.plan->>'plan_id'=$3`,[current.tenantId,current.userId,request.params.planId]));
    const sourceIds=(saved.rows[0]?.plan.scope as {source_ids?:string[]}|undefined)?.source_ids;
    if(!saved.rowCount||!sourceIds?.length)return reply.code(404).send({error:'saved_question_not_found'});
    try{
      const sources=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{source_id:string;agent_id:string;group_id:string;group_version:number}>(
        `SELECT connection_id AS source_id,connector_agent_id AS agent_id,source_group_id AS group_id,source_group_version AS group_version
         FROM registry.connections WHERE tenant_id=$1 AND status='active' AND connection_id=ANY($2::uuid[])`,[current.tenantId,sourceIds]));
      if(sources.rowCount!==sourceIds.length)return reply.code(403).send({error:'source_not_active_or_available'});
      const plan=await createAnalyticPlan({question:String(saved.rows[0]!.plan.question),runId:randomUUID(),sources:sources.rows.map(row=>({sourceId:row.source_id,agentId:row.agent_id,groupId:row.group_id,groupVersion:row.group_version}))});
      return reply.code(201).send({...await startAnalyticRun(options.pool,{tenantId:current.tenantId,principalId:current.userId,plan}),planId:plan.plan_id});
    }catch(error){const code=error instanceof Error?error.message:'saved_question_start_failed';if(['principal_not_entitled','source_not_active','source_group_version_not_pinned'].includes(code))return reply.code(403).send({error:code});if(code.startsWith('analytic_plan'))return reply.code(400).send({error:code});throw error;}
  });
  app.delete<{Params:{planId:string}}>('/api/me/saved-questions/:planId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const memory=await getPersonalMemory(options.pool,{tenantId:current.tenantId,principalId:current.userId});
    if(!memory.savedPlanIds.includes(request.params.planId))return reply.code(404).send({error:'saved_question_not_found'});
    await putPersonalMemory(options.pool,{tenantId:current.tenantId,principalId:current.userId,memory:{...memory,savedPlanIds:memory.savedPlanIds.filter(id=>id!==request.params.planId)}});
    return reply.send({deleted:true});
  });
  app.get('/api/me/reports',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const rows=await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query("SELECT set_config('app.principal_id',$1,true)",[current.userId]);
      return client.query<{report_id:string;name:string;governed_id:string;version:number;snapshot_id:string|null;run_id:string|null;created_at:Date|null}>(
        `SELECT d.report_id,d.name,d.governed_id,d.version,s.snapshot_id,s.run_id,s.created_at FROM reports.definitions d
         LEFT JOIN LATERAL(SELECT snapshot_id,run_id,created_at FROM reports.snapshots WHERE tenant_id=d.tenant_id AND report_id=d.report_id ORDER BY created_at DESC LIMIT 1)s ON true
         WHERE d.tenant_id=$1 AND d.owner_id=$2 ORDER BY d.created_at DESC`,[current.tenantId,current.userId]);
    });
    return reply.send({reports:rows.rows.map(row=>({reportId:row.report_id,name:row.name,governedId:row.governed_id,version:row.version,latestSnapshotId:row.snapshot_id,latestRunId:row.run_id,latestSnapshotAt:row.created_at?.toISOString()??null}))});
  });
  app.post<{Body:{name?:string;governedId?:string;version?:number}}>('/api/me/reports',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const {name,governedId,version}=request.body??{};
    if(typeof name!=='string'||!name.trim()||name.trim().length>120||typeof governedId!=='string'||!Number.isInteger(version)||version!<1)return reply.code(400).send({error:'invalid_report_definition'});
    try{await getApprovedGovernedVersion(options.pool,{tenantId:current.tenantId,governedId,version:version!});}
    catch(error){if(error instanceof Error&&error.message==='governed_version_not_approved')return reply.code(409).send({error:error.message});if(error instanceof Error&&error.message==='governed_version_not_found')return reply.code(404).send({error:error.message});throw error;}
    const row=await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query("SELECT set_config('app.principal_id',$1,true)",[current.userId]);
      return client.query<{report_id:string}>('INSERT INTO reports.definitions(tenant_id,owner_id,name,governed_id,version) VALUES($1,$2,$3,$4,$5) RETURNING report_id',[current.tenantId,current.userId,name.trim(),governedId,version]);
    });
    return reply.code(201).send({reportId:row.rows[0]!.report_id,name:name.trim(),governedId,version});
  });
  app.post<{Params:{reportId:string}}>('/api/me/reports/:reportId/run',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const row=await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query("SELECT set_config('app.principal_id',$1,true)",[current.userId]);
      return client.query<{governed_id:string;version:number}>('SELECT governed_id,version FROM reports.definitions WHERE tenant_id=$1 AND report_id=$2 AND owner_id=$3',[current.tenantId,request.params.reportId,current.userId]);
    });
    if(!row.rowCount)return reply.code(404).send({error:'report_not_found'});
    try{
      const approved=await getApprovedGovernedVersion(options.pool,{tenantId:current.tenantId,governedId:row.rows[0]!.governed_id,version:row.rows[0]!.version});
      const plan=AnalyticPlanSchema.parse({...approved.plan,run_id:randomUUID(),plan_hash:'0'.repeat(64)});plan.plan_hash=await hashPlan({...plan,plan_hash:''});
      const run=await startAnalyticRun(options.pool,{tenantId:current.tenantId,principalId:current.userId,plan,governed:{governedId:row.rows[0]!.governed_id,version:approved.version}});
      return reply.code(201).send({...run,reportId:request.params.reportId,version:approved.version});
    }catch(error){const code=error instanceof Error?error.message:'report_run_failed';if(code==='principal_not_entitled')return reply.code(403).send({error:code});if(['governed_version_not_found','governed_version_not_approved'].includes(code))return reply.code(409).send({error:code});throw error;}
  });
  app.get<{Params:{reportId:string;format:string}}>('/api/me/reports/:reportId/exports/:format',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const format=request.params.format as ExportFormat;if(!['pdf','xlsx','pptx'].includes(format))return reply.code(400).send({error:'unsupported_export_format'});
    const row=await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query("SELECT set_config('app.principal_id',$1,true)",[current.userId]);
      return client.query<{snapshot_id:string;run_id:string;safe_pack:SafeEvidencePack;content_hash:string}>('SELECT s.snapshot_id,s.run_id,s.safe_pack,s.content_hash FROM reports.snapshots s JOIN reports.definitions d USING(tenant_id,report_id) WHERE s.tenant_id=$1 AND s.report_id=$2 AND d.owner_id=$3 ORDER BY s.created_at DESC LIMIT 1',[current.tenantId,request.params.reportId,current.userId]);
    });
    if(!row.rowCount)return reply.code(404).send({error:'report_snapshot_not_found'});
    const rendered=await renderEvidencePack(row.rows[0]!.safe_pack,format);
    await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query("SELECT set_config('app.principal_id',$1,true)",[current.userId]);
      await client.query('INSERT INTO reports.export_events(tenant_id,run_id,principal_id,format,content_hash) VALUES($1,$2,$3,$4,$5)',[current.tenantId,row.rows[0]!.run_id,current.userId,format,rendered.contentHash]);
    });
    return reply.type(rendered.contentType).header('content-disposition',`attachment; filename="${rendered.filename}"`).header('x-content-sha256',rendered.contentHash).send(rendered.bytes);
  });
  app.get('/api/me/schedules',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const rows=await withTenant(options.pool,current.tenantId,async(client)=>{await client.query("SELECT set_config('app.principal_id',$1,true)",[current.userId]);return client.query<{schedule_id:string;report_id:string;local_time:string;cadence:string;local_weekday:number|null;tenant_time_zone:string;next_run_at:Date;enabled:boolean}>('SELECT schedule_id,report_id,local_time::text AS local_time,cadence,local_weekday,tenant_time_zone,next_run_at,enabled FROM reports.schedules WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at',[current.tenantId,current.userId]);});
    return reply.send({schedules:rows.rows.map((row)=>({scheduleId:row.schedule_id,reportId:row.report_id,localTime:row.local_time.slice(0,5),cadence:row.cadence,weekday:row.local_weekday,timeZone:row.tenant_time_zone,nextRunAt:row.next_run_at.toISOString(),enabled:row.enabled}))});
  });
  app.post<{Body:{reportId?:string;localTime?:string;cadence?:string;weekday?:number}}>('/api/me/schedules',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const {reportId,localTime,cadence='daily',weekday}=request.body??{};if(typeof reportId!=='string'||typeof localTime!=='string'||!['daily','weekly'].includes(cadence)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)||(cadence==='weekly'&&(!Number.isInteger(weekday)||weekday!<1||weekday!>7))||(cadence==='daily'&&weekday!==undefined))return reply.code(400).send({error:'invalid_schedule'});
    const row=await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query("SELECT set_config('app.principal_id',$1,true)",[current.userId]);
      const tenant=await client.query<{time_zone:string}>('SELECT time_zone FROM core.tenants WHERE tenant_id=$1',[current.tenantId]);const timeZone=tenant.rows[0]?.time_zone;if(!timeZone)throw new Error('tenant_not_found');
      let nextRunAt:Date;try{nextRunAt=nextScheduleInstant({after:new Date(),cadence:cadence as 'daily'|'weekly',timeZone,localTime,...(weekday===undefined?{}:{weekday})});}catch(error){if(error instanceof Error&&error.message==='schedule_local_time_does_not_exist')throw error;throw new Error('invalid_schedule');}
      return client.query<{schedule_id:string;next_run_at:Date}>(
        `WITH owned AS(SELECT report_id FROM reports.definitions WHERE tenant_id=$1 AND report_id=$2 AND owner_id=$3)
         INSERT INTO reports.schedules(tenant_id,report_id,owner_id,local_time,next_run_at,cadence,tenant_time_zone,local_weekday) SELECT $1,o.report_id,$3,$4::time,$5::timestamptz,$6,$7,$8 FROM owned o
         ON CONFLICT(tenant_id,report_id) DO UPDATE SET local_time=EXCLUDED.local_time,next_run_at=EXCLUDED.next_run_at,cadence=EXCLUDED.cadence,tenant_time_zone=EXCLUDED.tenant_time_zone,local_weekday=EXCLUDED.local_weekday,enabled=true
         RETURNING schedule_id,next_run_at`,[current.tenantId,reportId,current.userId,localTime,nextRunAt,cadence,timeZone,weekday??null]);
    });
    if(!row.rowCount)return reply.code(404).send({error:'report_not_found'});
    const timeZone=(await withTenant(options.pool,current.tenantId,client=>client.query<{time_zone:string}>('SELECT time_zone FROM core.tenants WHERE tenant_id=$1',[current.tenantId]))).rows[0]!.time_zone;
    return reply.code(201).send({scheduleId:row.rows[0]!.schedule_id,reportId,localTime,cadence,weekday:weekday??null,timeZone,nextRunAt:row.rows[0]!.next_run_at.toISOString()});
  });
  app.delete<{Params:{scheduleId:string}}>('/api/me/schedules/:scheduleId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>{await client.query("SELECT set_config('app.principal_id',$1,true)",[current.userId]);return client.query('UPDATE reports.schedules SET enabled=false WHERE tenant_id=$1 AND schedule_id=$2 AND owner_id=$3',[current.tenantId,request.params.scheduleId,current.userId]);});
    if(!result.rowCount)return reply.code(404).send({error:'schedule_not_found'});return reply.send({disabled:true});
  });
  app.get<{Params:{runId:string};Querystring:{after?:string}}>('/api/runs/:runId/events',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const owner=await withTenant(options.pool,current.tenantId,async(client)=>client.query('SELECT 1 FROM runs.runs WHERE tenant_id=$1 AND run_id=$2 AND principal_id=$3',[current.tenantId,request.params.runId,current.userId]));
    if(!owner.rowCount)return reply.code(404).send({error:'run_not_found'});
    const lastId=request.headers['last-event-id'];const cursor=typeof lastId==='string'?lastId:request.query.after??'0';
    if(!/^\d+$/.test(cursor)||Number(cursor)>Number.MAX_SAFE_INTEGER)return reply.code(400).send({error:'invalid_event_cursor'});
    return reply.send({events:await eventsAfter(options.pool,current.tenantId,request.params.runId,Number(cursor))});
  });

  app.get('/api/sources',async(request,reply)=>{
    if(!await authenticatedSession(request))return reply.code(401).send({error:'unauthorized'});
    return reply.send({sources:availableConnectorSources()});
  });
  app.get('/api/agents',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>{
      const groups=await client.query<{group_id:string;version:number;connection_id:string;connector_type:string;agent_id:string}>('SELECT g.source_group_id AS group_id,g.version,c.connection_id,c.connector_type,c.connector_agent_id AS agent_id FROM registry.source_groups g JOIN registry.source_group_members m ON m.tenant_id=g.tenant_id AND m.source_group_id=g.source_group_id AND m.group_version=g.version AND m.valid_to IS NULL JOIN registry.connections c ON c.tenant_id=m.tenant_id AND c.connection_id=m.connection_id WHERE g.tenant_id=$1 ORDER BY g.source_group_id,c.connection_id',[current.tenantId]);
      const governed=await client.query<{governed_id:string;name:string;owner_id:string;version:number;approved_by:string|null}>('SELECT d.governed_id,d.name,d.owner_id,v.version,a.approved_by FROM registry.governed_definitions d JOIN registry.governed_versions v USING(tenant_id,governed_id) LEFT JOIN registry.governed_approvals a USING(tenant_id,governed_id,version) WHERE d.tenant_id=$1 ORDER BY d.governed_id,v.version',[current.tenantId]);
      const agents=await client.query<{agent_id:string;agent_type:string;status:string;owner_id:string|null;active_version:number}>('SELECT agent_id,agent_type,status,owner_id,active_version FROM registry.agents WHERE tenant_id=$1 ORDER BY created_at',[current.tenantId]);
      return{groups:groups.rows.map(row=>({groupId:row.group_id,version:row.version,connectionId:row.connection_id,connectorType:row.connector_type,agentId:row.agent_id})),governed:governed.rows.map(row=>({governedId:row.governed_id,name:row.name,ownerId:row.owner_id,version:row.version,approvedBy:row.approved_by})),agents:agents.rows};
    });return reply.send(result);
  });
  app.get('/api/evaluation',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    return reply.send(await withTenant(options.pool,current.tenantId,async(client)=>{const result=await client.query<{question_hash:string}>('SELECT question_hash FROM memory.evaluation_cases WHERE tenant_id=$1 ORDER BY created_at',[current.tenantId]);return{count:result.rowCount??0,questionIds:result.rows.map(row=>row.question_hash)};}));
  });
  app.get('/api/connections',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query(
      `SELECT c.connection_id,c.connector_type,c.status,c.source_ref,c.display_name,c.connector_agent_id,
        (SELECT state FROM profiler.jobs j WHERE j.tenant_id=c.tenant_id AND j.connection_id=c.connection_id ORDER BY created_at DESC LIMIT 1) AS last_job_state
       FROM registry.connections c WHERE c.tenant_id=$1 ORDER BY c.created_at DESC`,[current.tenantId]));
    return reply.send({connections:result.rows.map((row)=>({
      connectionId:row.connection_id,
      connectorType:row.connector_type,
      displayName:row.display_name,
      status:row.status,
      agentId:row.connector_agent_id,
      lastJobState:row.last_job_state,
    }))});
  });
  app.get('/api/analytic/sources',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{connection_id:string;connector_type:string}>(
      `SELECT c.connection_id,c.connector_type FROM registry.connections c JOIN registry.capabilities cap ON cap.tenant_id=c.tenant_id AND cap.capability_id='analytic.read'
       WHERE c.tenant_id=$1 AND c.status='active' AND cap.enabled AND cap.effect_class='READ' AND cap.active_version=1
       AND EXISTS(SELECT 1 FROM core.entitlements e WHERE e.tenant_id=c.tenant_id AND e.principal_id=$2 AND e.capability_id='analytic.read' AND e.allowed AND (e.resource_id IS NULL OR e.resource_id=c.connection_id::text))
       ORDER BY c.created_at`,[current.tenantId,current.userId]));
    return reply.send({sources:result.rows.map(row=>({id:row.connection_id,type:row.connector_type}))});
  });
  app.post<{Params:{groupId:string;connectionId:string}}>('/api/groups/:groupId/members/:connectionId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    try{return reply.send(await moveConnectionToGroup(options.pool,{tenantId:current.tenantId,connectionId:request.params.connectionId,targetGroupId:request.params.groupId,actor:'person'}));}
    catch(error){const code=error instanceof Error?error.message:'group_move_failed';if(code==='connection_not_found'||code==='source_group_not_found')return reply.code(404).send({error:code});throw error;}
  });
  app.post<{Body:{name?:string;question?:string;sourceIds?:string[];governedId?:string}}>('/api/governed-agents',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const {name,question,sourceIds,governedId}=request.body??{};
    if(typeof name!=='string'||!name.trim()||typeof question!=='string'||!question.trim()||!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.some((id)=>typeof id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))return reply.code(400).send({error:'invalid_governed_draft'});
    const sources=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{source_id:string;agent_id:string;group_id:string;group_version:number}>(
      `SELECT connection_id AS source_id,connector_agent_id AS agent_id,source_group_id AS group_id,source_group_version AS group_version
       FROM registry.connections WHERE tenant_id=$1 AND status='active' AND connection_id=ANY($2::uuid[])`,[current.tenantId,sourceIds]));
    if(sources.rowCount!==new Set(sourceIds).size)return reply.code(403).send({error:'source_not_active_or_available'});
    try{const plan=await createAnalyticPlan({question,runId:randomUUID(),sources:sources.rows.map((source)=>({sourceId:source.source_id,agentId:source.agent_id,groupId:source.group_id,groupVersion:source.group_version}))});const draft=await createGovernedDraft(options.pool,{tenantId:current.tenantId,principalId:current.userId,name,plan, ...(governedId?{governedId}:{})});return reply.code(201).send(draft);}
    catch(error){const code=error instanceof Error?error.message:'governed_draft_failed';if(['governed_definition_not_found','governed_definition_forbidden'].includes(code))return reply.code(404).send({error:code});if(code.startsWith('invalid_'))return reply.code(400).send({error:code});throw error;}
  });
  app.post<{Params:{governedId:string};Body:{version?:number}}>('/api/governed-agents/:governedId/approve',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!Number.isInteger(request.body?.version)||request.body!.version!<1)return reply.code(400).send({error:'invalid_governed_version'});
    try{return reply.send(await approveGovernedVersion(options.pool,{tenantId:current.tenantId,principalId:current.userId,governedId:request.params.governedId,version:request.body!.version!}));}
    catch(error){const code=error instanceof Error?error.message:'governed_approval_failed';if(code==='governed_self_approval_not_allowed')return reply.code(403).send({error:code});if(code==='governed_version_not_found')return reply.code(404).send({error:code});throw error;}
  });
  app.post<{Params:{governedId:string};Body:{version?:number}}>('/api/governed-agents/:governedId/runs',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!Number.isInteger(request.body?.version)||request.body!.version!<1)return reply.code(400).send({error:'invalid_governed_version'});
    try{
      const approved=await getApprovedGovernedVersion(options.pool,{tenantId:current.tenantId,governedId:request.params.governedId,version:request.body!.version!});
      const plan=AnalyticPlanSchema.parse({...approved.plan,run_id:randomUUID(),plan_hash:'0'.repeat(64)});
      plan.plan_hash=await hashPlan({...plan,plan_hash:''});
      const run=await startAnalyticRun(options.pool,{tenantId:current.tenantId,principalId:current.userId,plan,governed:{governedId:request.params.governedId,version:approved.version}});
      return reply.code(201).send({...run,governedId:request.params.governedId,version:approved.version});
    }catch(error){const code=error instanceof Error?error.message:'governed_run_failed';if(['governed_version_not_found','governed_version_not_approved'].includes(code))return reply.code(404).send({error:code});if(code==='principal_not_entitled')return reply.code(403).send({error:code});if(code==='governed_plan_mismatch'||code.startsWith('analytic_plan'))return reply.code(400).send({error:code});throw error;}
  });
  app.post<{Body:{sourceId?:string;connectorType?:string;displayName?:string;credential?:{host?:string;port?:number;database?:string;username?:string;password?:string;sslMode?:string}}}>('/api/connections',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const source=request.body?.sourceId?availableConnectorSources().find((item)=>item.id===request.body?.sourceId):undefined;
    if(request.body?.sourceId&&!source)return reply.code(400).send({error:'connector_source_not_found'});
    const connectorType=source?.type??request.body?.connectorType;
    if(connectorType!=='postgres')return reply.code(400).send({error:'connector_type_unsupported'});
    const displayName=(request.body?.displayName??source?.name??'').trim();if(displayName.length<1||displayName.length>120)return reply.code(400).send({error:'connection_name_invalid'});
    if(source){const draft=await createConnectionDraft(options.pool,{tenantId:current.tenantId,connectorType:source.type as ConnectorType,sourceRef:source.id});await withTenant(options.pool,current.tenantId,client=>client.query('UPDATE registry.connections SET display_name=$3 WHERE tenant_id=$1 AND connection_id=$2',[current.tenantId,draft.connectionId,displayName]));return reply.code(201).send({connectionId:draft.connectionId,status:'draft',connectorType:source.type,sourceName:displayName});}
    const input=request.body?.credential;const sslMode=input?.sslMode??'require';
    if(!input?.host||input.host.length>253||!Number.isInteger(input.port)||input.port!<1||input.port!>65535||!input.database||input.database.length>63||!input.username||input.username.length>128||!input.password||input.password.length>1024||!['disable','require','verify-full'].includes(sslMode))return reply.code(400).send({error:'postgres_credentials_invalid'});
    const encrypted=encryptConnectionSecret({host:input.host,port:input.port,database:input.database,username:input.username,password:input.password,sslMode});
    const draft=await withTenant(options.pool,current.tenantId,async(client)=>{const inserted=await client.query<{connection_id:string}>("INSERT INTO registry.connections(tenant_id,connector_type,status,display_name) VALUES($1,'postgres','draft',$2) RETURNING connection_id",[current.tenantId,displayName]);const id=inserted.rows[0]!.connection_id;await client.query('INSERT INTO registry.connection_secrets(tenant_id,connection_id,secret_version,ciphertext,nonce,auth_tag) VALUES($1,$2,1,$3,$4,$5)',[current.tenantId,id,Buffer.from(encrypted.ciphertext,'base64'),Buffer.from(encrypted.nonce,'base64'),Buffer.from(encrypted.authTag,'base64')]);return{id};});
    return reply.code(201).send({connectionId:draft.id,status:'draft',connectorType:'postgres',sourceName:displayName});
  });
  app.post<{Params:{connectionId:string}}>('/api/connections/:connectionId/test',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const draft=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{status:string}>('SELECT status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2',[current.tenantId,request.params.connectionId]));
    if(draft.rows[0]?.status!=='draft')return reply.code(404).send({error:'connection_draft_not_found'});
    try{return reply.send(await (await connectorForConnection(current.tenantId,request.params.connectionId)).test());}catch(error){const code=error instanceof Error?error.message:'connection_test_failed';if(['postgres_connector_role_not_read_only','source_connection_requires_credentials','postgres_connection_string_required'].includes(code))return reply.code(400).send({error:code});throw error;}
  });
  app.post<{Params:{connectionId:string};Body:{scope?:Array<{qualifiedName:string;objectType:string;scopeMode:'profile'|'list_only'|'exclude'}>}}>('/api/connections/:connectionId/activate',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const draft=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{source_ref:string|null;connector_type:string;display_name:string;status:string}>('SELECT source_ref,connector_type,display_name,status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2',[current.tenantId,request.params.connectionId]));
    const row=draft.rows[0];if(!row||row.status!=='draft'||row.connector_type!=='postgres')return reply.code(404).send({error:'connection_draft_not_found'});
    let connector:ReadOnlyConnector;try{connector=await connectorForConnection(current.tenantId,request.params.connectionId);const checked=await connector.test();if(!checked.ok)return reply.code(400).send({error:'connection_test_failed'});}catch(error){const code=error instanceof Error?error.message:'connection_test_failed';if(['postgres_connector_role_not_read_only','source_connection_requires_credentials'].includes(code))return reply.code(400).send({error:code});throw error;}
    const scope=request.body?.scope??[];
    const activated=await activateConnection(options.pool,{tenantId:current.tenantId,principalId:current.userId,connectorType:'postgres',connectionId:request.params.connectionId,...(row.source_ref?{sourceRef:row.source_ref}:{}),scope});
    await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true) ON CONFLICT(tenant_id,capability_id) DO UPDATE SET enabled=true,effect_class='READ',effect_safety='not_applicable'",[current.tenantId]);
      await client.query("INSERT INTO registry.capability_versions(tenant_id,capability_id,version,input_schema,output_schema) VALUES($1,'analytic.read',1,'{}'::jsonb,'{}'::jsonb) ON CONFLICT DO NOTHING",[current.tenantId]);
      const existing=await client.query("SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='analytic.read' AND resource_id=$3 AND allowed",[current.tenantId,current.userId,activated.connectionId]);
      if(!existing.rowCount)await client.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id,allowed) VALUES($1,$2,'analytic.read',$3,true)",[current.tenantId,current.userId,activated.connectionId]);
    });
    const profile=await runProfile(options.pool,{tenantId:current.tenantId,connectionId:activated.connectionId,connector,jobType:'discovery'});
    return reply.send({connectionId:activated.connectionId,agentId:activated.agentId,sourceName:row.display_name,profile});
  });
  app.post<{Params:{connectionId:string};Body:{jobType?:'profile'|'nightly'}}>('/api/connections/:connectionId/discover',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const connection=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{source_ref:string|null;status:string}>(
      'SELECT source_ref,status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2',[current.tenantId,request.params.connectionId]));
    const row=connection.rows[0];if(!row||row.status!=='active')return reply.code(404).send({error:'active_connection_not_found'});
    if(request.body?.jobType&&!['profile','nightly'].includes(request.body.jobType))return reply.code(400).send({error:'invalid_job_type'});
    const result=await runProfile(options.pool,{tenantId:current.tenantId,connectionId:request.params.connectionId,connector:await connectorForConnection(current.tenantId,request.params.connectionId),jobType:request.body?.jobType??'profile'});
    return reply.send(result);
  });
  app.get<{Params:{connectionId:string}}>('/api/connections/:connectionId/profile',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query(
      `SELECT j.job_id,j.job_type,j.state,j.listed_count,j.profiled_count,j.inaccessible_count,j.created_at,
        count(DISTINCT a.asset_id)::int AS dataset_count,count(DISTINCT f.asset_id)::int AS field_count
       FROM profiler.jobs j LEFT JOIN graph.assets a ON a.tenant_id=j.tenant_id AND a.source_id=j.connection_id AND a.asset_type='dataset'
       LEFT JOIN graph.assets f ON f.tenant_id=j.tenant_id AND f.source_id=j.connection_id AND f.asset_type='field'
       WHERE j.tenant_id=$1 AND j.connection_id=$2 GROUP BY j.tenant_id,j.job_id ORDER BY j.created_at DESC LIMIT 1`,
      [current.tenantId,request.params.connectionId]));
    return reply.send({profile:result.rows[0]??null});
  });
  app.get<{Params:{connectionId:string}}>('/api/connections/:connectionId/dictionary',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query(
      `SELECT dataset.asset_id,dataset.qualified_name,
        COALESCE(jsonb_agg(jsonb_build_object('name',field.qualified_name,'dataType',fp.data_type,'nullable',fp.is_nullable,'tags',fp.sensitivity_tags,'nullRate',fp.null_rate,'distinctCount',fp.distinct_count)) FILTER (WHERE field.asset_id IS NOT NULL),'[]'::jsonb) AS fields
       FROM graph.assets dataset LEFT JOIN graph.relationships r ON r.tenant_id=dataset.tenant_id AND r.from_asset_id=dataset.asset_id AND r.relationship_type='CONTAINS'
       LEFT JOIN graph.assets field ON field.tenant_id=r.tenant_id AND field.asset_id=r.to_asset_id
       LEFT JOIN LATERAL (SELECT data_type,is_nullable,sensitivity_tags,null_rate,distinct_count FROM profiler.field_profiles p WHERE p.tenant_id=field.tenant_id AND p.asset_id=field.asset_id ORDER BY profile_version DESC LIMIT 1) fp ON true
       WHERE dataset.tenant_id=$1 AND dataset.source_id=$2 AND dataset.asset_type='dataset' AND dataset.active=true
       GROUP BY dataset.asset_id,dataset.qualified_name ORDER BY dataset.qualified_name`,[current.tenantId,request.params.connectionId]));
    return reply.send({tables:result.rows});
  });
  app.get<{Params:{connectionId:string}}>('/api/connections/:connectionId/er',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query(
      `SELECT r.relationship_type,r.granularity,f.qualified_name AS from_name,t.qualified_name AS to_name,a.evidence_method,a.review_status,a.verification
       FROM graph.relationships r JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id
       JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id
       LEFT JOIN graph.assertions a ON a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id
       WHERE r.tenant_id=$1 AND (f.source_id=$2 OR t.source_id=$2) AND r.family='structural' ORDER BY r.relationship_type,f.qualified_name`,
      [current.tenantId,request.params.connectionId]));
    return reply.send({relationships:result.rows});
  });
  app.get<{Querystring:{q?:string}}>('/api/catalogue/search',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const query=request.query.q?.trim();if(!query)return reply.code(400).send({error:'query_required'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{qualified_name:string}>(
      `SELECT DISTINCT dataset.qualified_name FROM graph.assets dataset
       LEFT JOIN graph.relationships r ON r.tenant_id=dataset.tenant_id AND r.from_asset_id=dataset.asset_id AND r.relationship_type='CONTAINS'
       LEFT JOIN graph.assets field ON field.tenant_id=r.tenant_id AND field.asset_id=r.to_asset_id
       WHERE dataset.tenant_id=$1 AND dataset.asset_type='dataset' AND dataset.active=true
         AND (dataset.qualified_name ILIKE $2 OR field.qualified_name ILIKE $2)
       ORDER BY dataset.qualified_name LIMIT 100`,[current.tenantId,`%${query}%`]));
    return reply.send({query,matches:result.rows.map(row=>row.qualified_name),modelRequests:0});
  });
  app.get<{Params:{connectionId:string}}>('/api/connections/:connectionId/scope',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    return reply.send({scope:await readConnectionScope(options.pool,current.tenantId,request.params.connectionId)});
  });
  app.put<{Params:{connectionId:string};Body:{rules?:Array<{qualifiedName:string;objectType:string;scopeMode:'profile'|'list_only'|'exclude'}>}}>('/api/connections/:connectionId/scope',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    await saveConnectionScope(options.pool,current.tenantId,request.params.connectionId,request.body?.rules??[]);
    return reply.send({saved:true});
  });
  app.post<{Params:{connectionId:string}}>('/api/connections/:connectionId/workbooks',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!options.artifactStore)return reply.code(503).send({error:'artifact_store_unavailable'});
    if(!Buffer.isBuffer(request.body)||request.body.length===0)return reply.code(400).send({error:'workbook_body_required'});
    const result=await storeWorkbook(options.pool,options.artifactStore,{tenantId:current.tenantId,connectionId:request.params.connectionId,bytes:request.body});
    return reply.code(201).send(result);
  });
  app.get<{Params:{connectionId:string;artifactId:string}}>('/api/connections/:connectionId/workbooks/:artifactId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(!options.artifactStore)return reply.code(503).send({error:'artifact_store_unavailable'});
    const bytes=await readWorkbook(options.pool,options.artifactStore,{tenantId:current.tenantId,connectionId:request.params.connectionId,artifactId:request.params.artifactId});
    return reply.type('application/octet-stream').send(bytes);
  });
  app.delete<{Params:{connectionId:string}}>('/api/connections/:connectionId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    await retireConnection(options.pool,options.artifactStore,{tenantId:current.tenantId,connectionId:request.params.connectionId,principalId:current.userId});
    return reply.code(204).send();
  });
  app.get('/api/notifications',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    return reply.send({notifications:await getNotifications(options.pool,current.tenantId,current.userId)});
  });
  app.post<{Params:{notificationId:string}}>('/api/notifications/:notificationId/read',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const updated=await markNotificationRead(options.pool,current.tenantId,current.userId,request.params.notificationId);
    return reply.send({updated});
  });
  return app;
}

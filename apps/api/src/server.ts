import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { withTenant, getUsage } from '@scaleinsyght/db';
import { activateConnection, approveGovernedVersion, createConnectionDraft, createGovernedDraft, deletePersonalMemory, getApprovedGovernedVersion, getPersonalMemory, moveConnectionToGroup, putPersonalMemory, type ConnectorType, type PersonalMemoryData } from '@scaleinsyght/registry';
import { createGoldenConnector, listGoldenSources } from '@scaleinsyght/connectors';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { getNotifications, markNotificationRead, readConnectionScope, readWorkbook, retireConnection, runGoldenProfile, saveConnectionScope, storeWorkbook } from '@scaleinsyght/profiler';
import { applyPersonalContext, createAnalyticPlan, startAnalyticRun, submitFeedback, type StructuredAnswer } from '@scaleinsyght/analytic';
import { eventsAfter } from '@scaleinsyght/runner';
import { AnalyticPlanSchema, FlowSpecSchema, hashPlan } from '@scaleinsyght/contracts';
import { compareGraphSnapshots, getIdentifierPath, getImpactRadius, importGoldenMetadata, listGraphAssertions, listGraphAssets, listGraphSnapshots, listIdentifierFields, listReports, queryLineage, reconcileAssertion, reviewGraphAssertion, traceIdentifier, verifyAssertionFromRun } from '@scaleinsyght/graph';
import { createGoldenHubAdapters, getGoldenHubFixtures, type FlowSpecDelivery, type SemanticsAdapter } from '@scaleinsyght/hub-adapters';
import { ClaimSchema, EvidenceRefSchema } from '@scaleinsyght/contracts';
import { authorise } from '@scaleinsyght/policy';

export interface GoldenAccount { tenantId: string; email: string; }
export interface ServerOptions { pool: Pool; sessionSecret: string; goldenAccounts: GoldenAccount[]; artifactStore?: EncryptedArtifactStore; hubAdapters?: { semantics: SemanticsAdapter; dataStudio: { product: 'data_studio'; version: number; connected: boolean; capabilities: readonly string[]; deliverFlowSpec(key: string, spec: FlowSpecDelivery): Promise<unknown>; lookupFlowSpec(key: string): Promise<unknown>; } }; }
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
function sign(value:string,secret:string):string{return createHmac('sha256',secret).update(value).digest('base64url');}

export async function buildServer(options:ServerOptions):Promise<FastifyInstance>{
  if(options.sessionSecret.length<32)throw new Error('SESSION_SECRET must contain at least 32 characters');
  const app=Fastify({logger:false,bodyLimit:25*1024*1024});
  const hubAdapters=options.hubAdapters??createGoldenHubAdapters(getGoldenHubFixtures());
  app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_request,payload,done)=>done(null,payload));
  app.get('/api/health',async()=>({status:'ok'}));
  app.get('/api/flowspecs',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const result=await withTenant(options.pool,current.tenantId,async(client)=>client.query(
      `SELECT f.flowspec_id AS "flowspecId",f.owner_id AS "ownerId",f.latest_version AS "latestVersion",v.subject_hash AS "subjectHash",a.status AS "approvalStatus"
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
      `SELECT f.flowspec_id AS "flowspecId",f.owner_id AS "ownerId",v.version,v.payload,v.subject_hash AS "subjectHash",v.source_snapshot_ids AS "sourceSnapshotIds",v.policy_version AS "policyVersion",a.status AS "approvalStatus",a.approved_by AS "approvedBy",a.expires_at AS "expiresAt"
       FROM hub.flowspecs f JOIN hub.flowspec_versions v USING(tenant_id,flowspec_id) LEFT JOIN hub.flowspec_approvals a USING(tenant_id,flowspec_id,version,subject_hash)
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
      await client.query("UPDATE hub.flowspec_approvals SET approved_by=$4,status='approved',decided_at=clock_timestamp() WHERE tenant_id=$1 AND flowspec_id=$2 AND version=$3",[current.tenantId,request.params.id,version,current.userId]);return 'approved';
    });
    if(outcome==='missing')return reply.code(404).send({error:'approval_not_found'});if(outcome==='self_approval')return reply.code(403).send({error:'second_member_required'});if(outcome!=='approved')return reply.code(409).send({error:'approval_not_pending'});return reply.send({flowspecId:request.params.id,version,status:'approved'});
  });
  app.get('/api/hub/adapters',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const adapters=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{product:string;connected:boolean;version:number;capabilities:string[];updated_at:Date}>(
      `SELECT a.product,a.connected,a.current_version AS version,v.capabilities,a.updated_at FROM hub.adapters a JOIN hub.adapter_versions v ON v.tenant_id=a.tenant_id AND v.product=a.product AND v.version=a.current_version WHERE a.tenant_id=$1 ORDER BY a.product`,[current.tenantId]));
    return reply.send({adapters:adapters.rows.map(({updated_at,...adapter})=>({...adapter,updatedAt:updated_at.toISOString()}))});
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
    const decision=await authorise(options.pool,{principal:{tenant_id:current.tenantId,principal_id:current.userId,kind:'user',roles:[],groups:[],attributes:{}},capability_id:'semantics.metric.read',resources:[selected.metric_id],purpose:'certified_metric_query',environment:'synthetic_golden'});
    if(decision.outcome!=='allow')return reply.code(403).send({error:'metric_not_authorized'});
    let answerResult;
    try{answerResult=await hubAdapters.semantics.queryCertifiedMetric(selected.metric_id);}
    catch(error){if(error instanceof Error&&error.message==='hub_adapter_disconnected')return reply.code(503).send({error:error.message});if(error instanceof Error&&error.message==='unknown_certified_metric')return reply.code(404).send({error:'certified_metric_not_found'});throw error;}
    const runId=randomUUID();const claimId=randomUUID();const evidenceId=randomUUID();
    const evidence=EvidenceRefSchema.parse({evidence_id:evidenceId,kind:'api_call',source_id:selected.adapter_id,asset_ids:[],locator:`hub://semantics/metrics/${selected.metric_id}`,content_hash:answerResult.evidence.contentHash,captured_at:new Date().toISOString(),collector_version:`semantics-v${answerResult.adapterVersion}`,redacted_summary:`Certified synthetic metric ${selected.metric_id} returned by Semantics`});
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
        await event('evidence_added',{result_ref:`golden://semantics/${runId}/${selected.metric_id}`,result_classification:'AGGREGATE',capability_id:'semantics.metric.read',capability_version:1});
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
    return reply.send({sources:[
      {id:'golden-dbt',type:'dbt',name:'Synthetic dbt manifest',fixtureKey:'dbt-manifest'},
      {id:'golden-tableau',type:'tableau',name:'Synthetic Tableau reports',fixtureKey:'tableau-reports'},
      {id:'golden-powerbi',type:'power_bi',name:'Synthetic Power BI reports',fixtureKey:'power-bi-reports'},
    ]});
  });
  app.post<{Body:{sourceId?:string}}>('/api/metadata/connections',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const sources=[{id:'golden-dbt',type:'dbt' as const},{id:'golden-tableau',type:'tableau' as const},{id:'golden-powerbi',type:'power_bi' as const}];
    const source=sources.find((item)=>item.id===request.body?.sourceId);if(!source)return reply.code(400).send({error:'unknown_synthetic_source'});
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
    const valid=(row.connector_type==='dbt'&&row.source_ref==='golden-dbt')||(row.connector_type==='tableau'&&row.source_ref==='golden-tableau')||(row.connector_type==='power_bi'&&row.source_ref==='golden-powerbi');
    if(!valid)return reply.code(400).send({error:'metadata_connection_mismatch'});
    if(row.status==='active')return reply.send({connectionId:request.params.connectionId,status:'active',connectorType:row.connector_type});
    if(row.status!=='draft')return reply.code(404).send({error:'metadata_connection_not_found'});
    const connection=await activateConnection(options.pool,{tenantId:current.tenantId,principalId:current.userId,connectorType:row.connector_type as ConnectorType,connectionId:request.params.connectionId,sourceRef:row.source_ref});
    return reply.send({connectionId:connection.connectionId,status:'active',connectorType:row.connector_type});
  });
  app.post<{Params:{connectionId:string};Body:{fixtureKey?:string}}>('/api/metadata/import/:connectionId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    if(typeof request.body?.fixtureKey!=='string')return reply.code(400).send({error:'invalid_golden_metadata_fixture'});
    try{return reply.send(await importGoldenMetadata(options.pool,{tenantId:current.tenantId,principalId:current.userId,connectionId:request.params.connectionId,fixtureKey:request.body.fixtureKey}));}
    catch(error){const code=error instanceof Error?error.message:'metadata_import_failed';if(code==='unknown_golden_metadata_fixture')return reply.code(400).send({error:'invalid_golden_metadata_fixture'});if(code==='metadata_connection_not_found')return reply.code(404).send({error:code});throw error;}
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
  app.post<{Body:{email?:string;password?:string}}>('/api/auth/login',async(request,reply)=>{
    const email=request.body?.email?.trim().toLowerCase();const password=request.body?.password;
    if(!email||!password)return reply.code(400).send({error:'invalid_credentials'});
    const account=options.goldenAccounts.find(item=>item.email.toLowerCase()===email);
    if(!account)return reply.code(401).send({error:'invalid_credentials'});
    const token=randomBytes(32).toString('base64url');const sessionId=randomUUID();
    const user=await withTenant(options.pool,account.tenantId,async(client)=>{
      const result=await client.query<{user_id:string;password_hash:string;is_active:boolean}>(
        'SELECT user_id,password_hash,is_active FROM core.users WHERE tenant_id=$1 AND email=$2',[account.tenantId,email]);
      const row=result.rows[0];if(!row||!row.is_active||!verifyPassword(password,row.password_hash))return null;
      await client.query(`INSERT INTO core.sessions(tenant_id,session_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,clock_timestamp()+interval '8 hours')`,[account.tenantId,sessionId,row.user_id,digest(token)]);
      await client.query(`INSERT INTO core.activity_events(tenant_id,event_type,principal_id) VALUES($1,'user_active',$2)`,[account.tenantId,row.user_id]);
      return row;
    });
    if(!user)return reply.code(401).send({error:'invalid_credentials'});
    const payload=Buffer.from(JSON.stringify({tenantId:account.tenantId,userId:user.user_id,sessionId,token})).toString('base64url');
    const cookie=`${payload}.${sign(payload,options.sessionSecret)}`;
    reply.header('set-cookie',`si_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs/1000}`);
    return reply.send({user:{email}});
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
  app.post<{ Params: { runId: string }; Body: { verdict?: 'useful' | 'not_useful'; correction?: { term: string; meaning: string } } }>('/api/runs/:runId/feedback',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const body=request.body;
    if(!body||!['useful','not_useful'].includes(String(body.verdict))||(body.correction&&(Object.keys(body.correction).sort().join(',')!=='meaning,term'||typeof body.correction.term!=='string'||typeof body.correction.meaning!=='string')))return reply.code(400).send({error:'invalid_feedback'});
    try{return reply.code(201).send(await submitFeedback(options.pool,{tenantId:current.tenantId,principalId:current.userId,runId:request.params.runId,verdict:body.verdict!,...(body.correction?{correction:body.correction}:{})}));}
    catch(error){const code=error instanceof Error?error.message:'feedback_failed';if(code==='run_not_found')return reply.code(404).send({error:code});if(code==='unsafe_correction'||code==='correction_not_allowed_for_useful_verdict')return reply.code(400).send({error:code});throw error;}
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
    return reply.send({sources:listGoldenSources()});
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
      `SELECT c.connection_id,c.connector_type,c.status,c.source_ref,c.connector_agent_id,
        (SELECT state FROM profiler.jobs j WHERE j.tenant_id=c.tenant_id AND j.connection_id=c.connection_id ORDER BY created_at DESC LIMIT 1) AS last_job_state
       FROM registry.connections c WHERE c.tenant_id=$1 ORDER BY c.created_at DESC`,[current.tenantId]));
    return reply.send({connections:result.rows.map((row)=>({
      connectionId:row.connection_id,
      connectorType:row.connector_type,
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
  app.post<{Body:{sourceId?:string}}>('/api/connections',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const source=listGoldenSources().find((item)=>item.id===request.body?.sourceId);
    if(!source)return reply.code(400).send({error:'unknown_synthetic_source'});
    const draft=await createConnectionDraft(options.pool,{tenantId:current.tenantId,connectorType:source.type as ConnectorType,sourceRef:source.id});
    return reply.code(201).send({connectionId:draft.connectionId,status:'draft',connectorType:source.type,sourceName:source.name});
  });
  app.post<{Params:{connectionId:string}}>('/api/connections/:connectionId/test',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const draft=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{source_ref:string|null;connector_type:string;status:string}>(
      'SELECT source_ref,connector_type,status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2',[current.tenantId,request.params.connectionId]));
    const row=draft.rows[0];if(!row||row.status!=='draft'||!row.source_ref)return reply.code(404).send({error:'connection_draft_not_found'});
    const source=listGoldenSources().find((item)=>item.id===row.source_ref);if(!source||source.type!==row.connector_type)return reply.code(400).send({error:'connection_source_mismatch'});
    return reply.send(await createGoldenConnector(source.id).test());
  });
  app.post<{Params:{connectionId:string};Body:{scope?:Array<{qualifiedName:string;objectType:string;scopeMode:'profile'|'list_only'|'exclude'}>}}>('/api/connections/:connectionId/activate',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const draft=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{source_ref:string|null;connector_type:string;status:string}>(
      'SELECT source_ref,connector_type,status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2',[current.tenantId,request.params.connectionId]));
    const row=draft.rows[0];if(!row||row.status!=='draft'||!row.source_ref)return reply.code(404).send({error:'connection_draft_not_found'});
    const source=listGoldenSources().find((item)=>item.id===row.source_ref);if(!source||source.type!==row.connector_type)return reply.code(400).send({error:'connection_source_mismatch'});
    const checked=await createGoldenConnector(source.id).test();if(!checked.ok)return reply.code(400).send({error:'connection_test_failed'});
    const scope=request.body?.scope??[];
    const activated=await activateConnection(options.pool,{tenantId:current.tenantId,principalId:current.userId,connectorType:source.type as ConnectorType,connectionId:request.params.connectionId,sourceRef:source.id,scope});
    await withTenant(options.pool,current.tenantId,async(client)=>{
      await client.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true) ON CONFLICT(tenant_id,capability_id) DO UPDATE SET enabled=true,effect_class='READ',effect_safety='not_applicable'",[current.tenantId]);
      await client.query("INSERT INTO registry.capability_versions(tenant_id,capability_id,version,input_schema,output_schema) VALUES($1,'analytic.read',1,'{}'::jsonb,'{}'::jsonb) ON CONFLICT DO NOTHING",[current.tenantId]);
      const existing=await client.query("SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='analytic.read' AND resource_id=$3 AND allowed",[current.tenantId,current.userId,activated.connectionId]);
      if(!existing.rowCount)await client.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id,allowed) VALUES($1,$2,'analytic.read',$3,true)",[current.tenantId,current.userId,activated.connectionId]);
    });
    const profile=await runGoldenProfile(options.pool,{tenantId:current.tenantId,connectionId:activated.connectionId,connector:createGoldenConnector(source.id),jobType:'discovery'});
    return reply.send({connectionId:activated.connectionId,agentId:activated.agentId,sourceName:source.name,profile});
  });
  app.post<{Params:{connectionId:string};Body:{jobType?:'profile'|'nightly'}}>('/api/connections/:connectionId/discover',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    const connection=await withTenant(options.pool,current.tenantId,async(client)=>client.query<{source_ref:string|null;status:string}>(
      'SELECT source_ref,status FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2',[current.tenantId,request.params.connectionId]));
    const row=connection.rows[0];if(!row||row.status!=='active'||!row.source_ref)return reply.code(404).send({error:'active_connection_not_found'});
    if(request.body?.jobType&&!['profile','nightly'].includes(request.body.jobType))return reply.code(400).send({error:'invalid_job_type'});
    const result=await runGoldenProfile(options.pool,{tenantId:current.tenantId,connectionId:request.params.connectionId,connector:createGoldenConnector(row.source_ref),jobType:request.body?.jobType??'profile'});
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

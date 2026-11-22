import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { withTenant, getUsage } from '@scaleinsyght/db';
import { activateConnection, createConnectionDraft, moveConnectionToGroup, type ConnectorType } from '@scaleinsyght/registry';
import { createGoldenConnector, listGoldenSources } from '@scaleinsyght/connectors';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { getNotifications, markNotificationRead, readConnectionScope, readWorkbook, retireConnection, runGoldenProfile, saveConnectionScope, storeWorkbook } from '@scaleinsyght/profiler';

export interface GoldenAccount { tenantId: string; email: string; }
export interface ServerOptions { pool: Pool; sessionSecret: string; goldenAccounts: GoldenAccount[]; artifactStore?: EncryptedArtifactStore; }
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
  app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_request,payload,done)=>done(null,payload));
  app.get('/api/health',async()=>({status:'ok'}));
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

  app.get('/api/sources',async(request,reply)=>{
    if(!await authenticatedSession(request))return reply.code(401).send({error:'unauthorized'});
    return reply.send({sources:listGoldenSources()});
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
  app.post<{Params:{groupId:string;connectionId:string}}>('/api/groups/:groupId/members/:connectionId',async(request,reply)=>{
    const current=await authenticatedSession(request);if(!current)return reply.code(401).send({error:'unauthorized'});
    try{return reply.send(await moveConnectionToGroup(options.pool,{tenantId:current.tenantId,connectionId:request.params.connectionId,targetGroupId:request.params.groupId,actor:'person'}));}
    catch(error){const code=error instanceof Error?error.message:'group_move_failed';if(code==='connection_not_found'||code==='source_group_not_found')return reply.code(404).send({error:code});throw error;}
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

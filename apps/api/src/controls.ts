import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant, type Pool } from '@scaleinsyght/db';
import { connectionQueryTimeout } from '@scaleinsyght/connectors';
import type { ControlsPolicy } from '@scaleinsyght/connectors';
import { decideControlChange, getControls, listControlChanges, saveControls, type ScopeRule } from '@scaleinsyght/profiler';

const uuid = {type:'string',pattern:'^[0-9a-fA-F-]{36}$'};
const name = {type:'string',minLength:1,maxLength:500};
const mode = {type:'string',enum:['profile','list_only','exclude']};
const object = (properties:Record<string,unknown>) => ({
  type:'object',properties,required:Object.keys(properties),additionalProperties:false,
});
const array = (items:unknown) => ({type:'array',maxItems:10000,items});
const policy = object({
  groups:{type:'object',maxProperties:50,additionalProperties:mode},
  nameRules:array(object({pattern:name,mode,reason:{type:'string',maxLength:500}})),
  columnRules:array(object({qualifiedName:name,mode:{type:'string',enum:['mask','exclude']}})),
  newObjects:{type:'string',enum:['approve','rules','ignore']},
  leavingScope:{const:'keep'},
  approval:{type:'boolean'},
});
const edit = object({
  revision:{type:'integer',minimum:0},
  policy,
  overrides:array(object({qualifiedName:name,objectType:name,scopeMode:mode})),
});
const statusByError: Record<string,number> = {
  tenant_admin_required:403,connection_not_found:404,control_change_not_pending:409,
  controls_revision_conflict:409,invalid_scope:400,
};

export function registerControlsRoutes(app:FastifyInstance,pool:Pool,session:(request:FastifyRequest)=>Promise<{tenantId:string;userId:string}|null>) {
  app.get<{Params:{connectionId:string}}>('/api/connections/:connectionId/controls',
    {schema:{params:object({connectionId:uuid})}},async(request,reply)=>{
      const current=await session(request);
      if(!current)return reply.code(401).send({error:'unauthorized'});
      return getControls(pool,current.tenantId,request.params.connectionId);
    });
  app.put<{Params:{connectionId:string};Body:{revision:number;policy:ControlsPolicy;overrides:ScopeRule[]}}>('/api/connections/:connectionId/controls',
    {schema:{params:object({connectionId:uuid}),body:edit}},async(request,reply)=>{
      const current=await session(request);
      if(!current)return reply.code(401).send({error:'unauthorized'});
      try {
        return await saveControls(pool,{...current,...request.params,...request.body});
      } catch(error) {
        if(error instanceof Error&&statusByError[error.message])return reply.code(statusByError[error.message]!).send({error:error.message});
        throw error;
      }
    });
  const validTimeout = (value: unknown) => value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 120000);
  type Limits = {profileMs:number|null;analyticMs:number|null};
  const queryLimits = '/api/connections/:connectionId/query-limits';
  const limitsResponse = (limits: Limits) => ({
    ...limits, effectiveProfileMs: connectionQueryTimeout('profile',limits.profileMs),
    effectiveAnalyticMs: connectionQueryTimeout('analytic',limits.analyticMs),
  });
  app.get<{Params:{connectionId:string}}>(queryLimits,{schema:{params:object({connectionId:uuid})}},async(request,reply)=>{
    const current=await session(request);
    if(!current)return reply.code(401).send({error:'unauthorized'});
    const {rows:[limits]}=await withTenant(pool,current.tenantId,db=>db.query<Limits>(
      `SELECT profile_query_timeout_ms AS "profileMs",analytic_query_timeout_ms AS "analyticMs" FROM registry.connections
       WHERE tenant_id=$1 AND connection_id=$2 AND status IN ('draft','active') AND connector_type IN ('postgres','sql_server','excel')`,
      [current.tenantId,request.params.connectionId]));
    return limits ? limitsResponse(limits) : reply.code(404).send({error:'connection_not_found'});
  });
  app.put<{Params:{connectionId:string};Body:Limits}>(queryLimits,
    {schema:{params:object({connectionId:uuid}),body:{type:'object',required:['profileMs','analyticMs']}}},async(request,reply)=>{
      const current=await session(request);
      if(!current)return reply.code(401).send({error:'unauthorized'});
      if(!validTimeout(request.body.profileMs)||!validTimeout(request.body.analyticMs))return reply.code(400).send({error:'invalid_query_limits'});
      return withTenant(pool,current.tenantId,async db=>{
        const allowed=await db.query(
          "SELECT 1 FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='tenant.admin' AND allowed AND resource_id IS NULL",
          [current.tenantId,current.userId]);
        if(!allowed.rowCount)return reply.code(403).send({error:'tenant_admin_required'});
        const {rows:[limits]}=await db.query<Limits>(
          `UPDATE registry.connections SET profile_query_timeout_ms=$3,analytic_query_timeout_ms=$4
           WHERE tenant_id=$1 AND connection_id=$2 AND status IN ('draft','active') AND connector_type IN ('postgres','sql_server','excel')
           RETURNING profile_query_timeout_ms AS "profileMs",analytic_query_timeout_ms AS "analyticMs"`,
          [current.tenantId,request.params.connectionId,request.body.profileMs,request.body.analyticMs]);
        return limits ? limitsResponse(limits) : reply.code(404).send({error:'connection_not_found'});
      });
    });
  app.get('/api/control-changes',async(request,reply)=>{
    const current=await session(request);
    if(!current)return reply.code(401).send({error:'unauthorized'});
    return {changes:await listControlChanges(pool,current.tenantId)};
  });
  app.post<{Params:{changeId:string};Body:{decision:'approved'|'rejected'}}>('/api/control-changes/:changeId/decision',
    {schema:{params:object({changeId:uuid}),body:object({decision:{type:'string',enum:['approved','rejected']}})}},async(request,reply)=>{
      const current=await session(request);
      if(!current)return reply.code(401).send({error:'unauthorized'});
      try {
        return await decideControlChange(pool,{...current,...request.params,...request.body});
      } catch(error) {
        if(error instanceof Error&&statusByError[error.message])return reply.code(statusByError[error.message]!).send({error:error.message});
        throw error;
      }
    });
}

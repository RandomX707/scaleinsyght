import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from '@scaleinsyght/db';
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

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { hashPlan, type EffectClass, type EffectSafety } from '@scaleinsyght/contracts';

export type ConnectorType = 'sql_server' | 'postgres' | 'snowflake' | 'excel' | 'dbt' | 'tableau' | 'power_bi';

export interface ActivateConnectionInput {
  tenantId: string;
  principalId: string;
  connectorType: ConnectorType;
  connectionId?: string;
  sourceRef?: string;
  scope?: Array<{ qualifiedName: string; objectType: string; scopeMode: 'profile' | 'list_only' | 'exclude' }>;
}

export interface ActivatedConnection {
  connectionId: string;
  agentId: string;
  sourceGroupId: string;
  sourceGroupVersion: 1;
}

export async function activateConnection(
  pool: Pool,
  input: ActivateConnectionInput,
): Promise<ActivatedConnection> {
  return withTenant(pool, input.tenantId, async (client) => {
    const tenant = await client.query<{ connector_allowance: number }>(
      'SELECT connector_allowance FROM core.tenants WHERE tenant_id = $1 FOR UPDATE',
      [input.tenantId],
    );
    if (!tenant.rowCount) throw new Error('tenant_not_found');
    const active = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM registry.connections WHERE tenant_id = $1 AND status = 'active'`,
      [input.tenantId],
    );
    if (Number(active.rows[0]?.count ?? 0) >= tenant.rows[0]!.connector_allowance) {
      throw new Error('connector_allowance_exceeded');
    }

    const connectionId = input.connectionId ?? randomUUID();
    if (input.connectionId) {
      const draft = await client.query<{ connector_type: string; status: string; source_ref: string | null }>(
        'SELECT connector_type,status,source_ref FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 FOR UPDATE',
        [input.tenantId, connectionId],
      );
      if (draft.rows[0]?.status !== 'draft' || draft.rows[0]?.connector_type !== input.connectorType) {
        throw new Error('connection_draft_invalid');
      }
      if (input.sourceRef && draft.rows[0]?.source_ref !== input.sourceRef) throw new Error('connection_source_mismatch');
    }
    const agentId = randomUUID();
    const sourceGroupId = randomUUID();
    await client.query(
      `INSERT INTO registry.source_groups (tenant_id, source_group_id, version, proposed_by)
       VALUES ($1, $2, 1, 'profiler')`,
      [input.tenantId, sourceGroupId],
    );
    await client.query(
      `INSERT INTO registry.agents (tenant_id, agent_id, agent_type, active_version, status, owner_id)
       VALUES ($1, $2, 'connector', 1, 'active', $3)`,
      [input.tenantId, agentId, input.principalId],
    );
    await client.query(
      `INSERT INTO registry.agent_versions (tenant_id, agent_id, version, capabilities, bindings)
       VALUES ($1, $2, 1, '[]'::jsonb, $3::jsonb)`,
      [input.tenantId, agentId, JSON.stringify({ connection_id: connectionId, source_group_id: sourceGroupId, source_group_version: 1 })],
    );
    if (input.connectionId) {
      const activated = await client.query(
        `UPDATE registry.connections SET status='active',connector_agent_id=$3,source_group_id=$4,source_group_version=1
         WHERE tenant_id=$1 AND connection_id=$2 AND status='draft'`,
        [input.tenantId, connectionId, agentId, sourceGroupId],
      );
      if (!activated.rowCount) throw new Error('connection_draft_invalid');
    } else {
      await client.query(
        `INSERT INTO registry.connections
         (tenant_id, connection_id, connector_type, status, connector_agent_id, source_group_id, source_group_version, source_ref)
         VALUES ($1, $2, $3, 'active', $4, $5, 1, $6)`,
        [input.tenantId, connectionId, input.connectorType, agentId, sourceGroupId, input.sourceRef ?? null],
      );
    }
    await client.query(
      `UPDATE registry.agents SET connection_id = $3 WHERE tenant_id = $1 AND agent_id = $2`,
      [input.tenantId, agentId, connectionId],
    );
    await client.query(
      `INSERT INTO registry.source_group_members (tenant_id, source_group_id, group_version, connection_id)
       VALUES ($1, $2, 1, $3)`,
      [input.tenantId, sourceGroupId, connectionId],
    );
    for (const rule of input.scope ?? []) {
      await client.query(
        `INSERT INTO registry.connection_scopes(tenant_id,connection_id,qualified_name,object_type,scope_mode)
         VALUES($1,$2,$3,$4,$5)`,
        [input.tenantId, connectionId, rule.qualifiedName, rule.objectType, rule.scopeMode],
      );
    }
    await client.query(
      `INSERT INTO registry.events (tenant_id, event_type, agent_id, connection_id, safe_payload)
       VALUES ($1, 'agent_created', $2, $3, $4::jsonb)`,
      [input.tenantId, agentId, connectionId, JSON.stringify({ connector_type: input.connectorType })],
    );
    await client.query(
      `INSERT INTO core.activity_events (tenant_id, event_type, principal_id, connector_id, connector_type)
       VALUES ($1, 'connector_activated', $2, $3, $4)`,
      [input.tenantId, input.principalId, connectionId, input.connectorType],
    );
    return { connectionId, agentId, sourceGroupId, sourceGroupVersion: 1 };
  });
}

export async function createConnectionDraft(
  pool: Pool,
  input: { tenantId: string; connectorType: ConnectorType; sourceRef: string },
): Promise<{ connectionId: string }> {
  if (!input.sourceRef.trim()) throw new Error('connection_source_required');
  return withTenant(pool, input.tenantId, async (client) => {
    const result = await client.query<{ connection_id: string }>(
      `INSERT INTO registry.connections(tenant_id,connector_type,status,source_ref)
       VALUES($1,$2,'draft',$3) RETURNING connection_id`,
      [input.tenantId, input.connectorType, input.sourceRef],
    );
    return { connectionId: result.rows[0]!.connection_id };
  });
}

export async function registerCapability(
  pool: Pool,
  tenantId: string,
  capability: {
    capabilityId: string;
    version: number;
    effectClass: EffectClass;
    effectSafety: EffectSafety;
    enabled: boolean;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  },
): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO registry.capabilities (tenant_id, capability_id, active_version, effect_class, effect_safety, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, capability.capabilityId, capability.version, capability.effectClass,
        capability.effectSafety, capability.effectClass === 'READ' && capability.enabled],
    );
    await client.query(
      `INSERT INTO registry.capability_versions (tenant_id, capability_id, version, input_schema, output_schema)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [tenantId, capability.capabilityId, capability.version,
        JSON.stringify(capability.inputSchema), JSON.stringify(capability.outputSchema)],
    );
  });
}

export async function moveConnectionToGroup(
  pool:Pool,
  input:{tenantId:string;connectionId:string;targetGroupId:string;actor:'profiler'|'person'},
):Promise<{groupId:string;version:number}>{
 return withTenant(pool,input.tenantId,async(client)=>{
  const connection=await client.query<{source_group_id:string;source_group_version:number}>('SELECT source_group_id,source_group_version FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 FOR UPDATE',[input.tenantId,input.connectionId]);
  const current=connection.rows[0];if(!current)throw new Error('connection_not_found');
  if(current.source_group_id===input.targetGroupId)return{groupId:current.source_group_id,version:current.source_group_version};
  const target=await client.query<{version:number}>('SELECT version FROM registry.source_groups WHERE tenant_id=$1 AND source_group_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE',[input.tenantId,input.targetGroupId]);
  if(!target.rowCount)throw new Error('source_group_not_found');
  const newVersion=target.rows[0]!.version+1;
  const oldMembers=await client.query<{connection_id:string}>('SELECT connection_id FROM registry.source_group_members WHERE tenant_id=$1 AND source_group_id=$2 AND group_version=$3 AND valid_to IS NULL ORDER BY connection_id',[input.tenantId,input.targetGroupId,target.rows[0]!.version]);
  const members=[...new Set([...oldMembers.rows.map(row=>row.connection_id),input.connectionId])];
  await client.query('INSERT INTO registry.source_groups(tenant_id,source_group_id,version,proposed_by) VALUES($1,$2,$3,$4)',[input.tenantId,input.targetGroupId,newVersion,input.actor]);
  await client.query('UPDATE registry.source_group_members SET valid_to=clock_timestamp() WHERE tenant_id=$1 AND valid_to IS NULL AND (connection_id=$2 OR source_group_id=$3)',[input.tenantId,input.connectionId,input.targetGroupId]);
  for(const connectionId of members){
   await client.query('INSERT INTO registry.source_group_members(tenant_id,source_group_id,group_version,connection_id) VALUES($1,$2,$3,$4)',[input.tenantId,input.targetGroupId,newVersion,connectionId]);
   await client.query('UPDATE registry.connections SET source_group_id=$3,source_group_version=$4 WHERE tenant_id=$1 AND connection_id=$2',[input.tenantId,connectionId,input.targetGroupId,newVersion]);
  }
  return{groupId:input.targetGroupId,version:newVersion};
 });
}

export interface PersonalMemoryData {
 vocabulary:Record<string,string>; defaultSources:string[]; savedPlanIds:string[];
 answerStyle:'concise'|'detailed'|'sql_first'|'lineage_first'|null;
 corrections?:Array<{term:string;meaning:string}>;
}
function validateMemory(memory:PersonalMemoryData):void{
 const unsafe=(text:string)=>/[\r\n;]|\b(?:select|insert|update|delete|drop)\b/i.test(text)||/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(text)||/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(text)||/\b\d{8,}\b/.test(text)||/\b(?:id|identifier|account|customer|email|ssn|phone)\s*[:=#]\s*\S+/i.test(text);
 if(Object.keys(memory.vocabulary).length>100||Object.entries(memory.vocabulary).some(([key,value])=>!key.trim()||key.length>120||value.length>500||unsafe(`${key} ${value}`))||[...memory.defaultSources,...memory.savedPlanIds].some(id=>!/^\w[\w-]{0,127}$/.test(id))||(memory.corrections??[]).length>100||(memory.corrections??[]).some(item=>!item.term.trim()||item.term.length>120||!item.meaning.trim()||item.meaning.length>500||unsafe(`${item.term} ${item.meaning}`)))throw new Error('invalid_personal_memory');
}
export async function putPersonalMemory(pool:Pool,input:{tenantId:string;principalId:string;memory:PersonalMemoryData}):Promise<void>{
 const memory=input.memory;validateMemory(memory);
 await withTenant(pool,input.tenantId,async(client)=>{
  await client.query("SELECT set_config('app.principal_id',$1,true)",[input.principalId]);
  await client.query(`INSERT INTO registry.personal_memories(tenant_id,person_id,vocabulary,default_sources,saved_plan_ids,answer_style,corrections)
   VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7::jsonb)
   ON CONFLICT(tenant_id,person_id) DO UPDATE SET vocabulary=EXCLUDED.vocabulary,default_sources=EXCLUDED.default_sources,saved_plan_ids=EXCLUDED.saved_plan_ids,answer_style=EXCLUDED.answer_style,corrections=EXCLUDED.corrections,updated_at=clock_timestamp()`,
   [input.tenantId,input.principalId,JSON.stringify(memory.vocabulary),JSON.stringify(memory.defaultSources),JSON.stringify(memory.savedPlanIds),memory.answerStyle,JSON.stringify(memory.corrections??[])]);
 });
}
export async function getPersonalMemory(pool:Pool,input:{tenantId:string;principalId:string}):Promise<PersonalMemoryData>{
 return withTenant(pool,input.tenantId,async(client)=>{
  await client.query("SELECT set_config('app.principal_id',$1,true)",[input.principalId]);
  const result=await client.query<{vocabulary:Record<string,string>;default_sources:string[];saved_plan_ids:string[];answer_style:PersonalMemoryData['answerStyle'];corrections:Array<{term:string;meaning:string}>}>('SELECT vocabulary,default_sources,saved_plan_ids,answer_style,corrections FROM registry.personal_memories WHERE tenant_id=$1 AND person_id=$2',[input.tenantId,input.principalId]);
  const row=result.rows[0];return row?{vocabulary:row.vocabulary,defaultSources:row.default_sources,savedPlanIds:row.saved_plan_ids,answerStyle:row.answer_style,corrections:row.corrections}:{vocabulary:{},defaultSources:[],savedPlanIds:[],answerStyle:null,corrections:[]};
 });
}
export async function deletePersonalMemory(pool:Pool,input:{tenantId:string;principalId:string}):Promise<boolean>{
 return withTenant(pool,input.tenantId,async(client)=>{await client.query("SELECT set_config('app.principal_id',$1,true)",[input.principalId]);const result=await client.query('DELETE FROM registry.personal_memories WHERE tenant_id=$1 AND person_id=$2',[input.tenantId,input.principalId]);return result.rowCount===1;});
}
export async function createGovernedDraft(pool:Pool,input:{tenantId:string;principalId:string;name:string;plan:Record<string,unknown>;governedId?:string}):Promise<{governedId:string;version:number;planHash:string}>{
 if(!input.name.trim()||input.name.length>160)throw new Error('invalid_governed_name');const planHash=await hashPlan(input.plan);
 return withTenant(pool,input.tenantId,async(client)=>{let governedId=input.governedId;let version=1;
  if(governedId){const row=await client.query<{latest_version:number;owner_id:string}>('SELECT latest_version,owner_id FROM registry.governed_definitions WHERE tenant_id=$1 AND governed_id=$2 FOR UPDATE',[input.tenantId,governedId]);if(!row.rowCount)throw new Error('governed_definition_not_found');if(row.rows[0]!.owner_id!==input.principalId)throw new Error('governed_definition_forbidden');version=row.rows[0]!.latest_version+1;await client.query('UPDATE registry.governed_definitions SET latest_version=$3,name=$4 WHERE tenant_id=$1 AND governed_id=$2',[input.tenantId,governedId,version,input.name]);}
  else{const result=await client.query<{governed_id:string}>('INSERT INTO registry.governed_definitions(tenant_id,owner_id,name,latest_version) VALUES($1,$2,$3,1) RETURNING governed_id',[input.tenantId,input.principalId,input.name]);governedId=result.rows[0]!.governed_id;}
  await client.query('INSERT INTO registry.governed_versions(tenant_id,governed_id,version,plan,plan_hash,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[input.tenantId,governedId,version,JSON.stringify(input.plan),planHash,input.principalId]);
  await client.query("INSERT INTO registry.governed_events(tenant_id,governed_id,version,event_type,principal_id) VALUES($1,$2,$3,'draft_created',$4)",[input.tenantId,governedId,version,input.principalId]);return{governedId,version,planHash};});
}
export async function approveGovernedVersion(pool:Pool,input:{tenantId:string;principalId:string;governedId:string;version:number}):Promise<{version:number}>{
 return withTenant(pool,input.tenantId,async(client)=>{const exists=await client.query<{owner_id:string}>('SELECT d.owner_id FROM registry.governed_versions v JOIN registry.governed_definitions d USING(tenant_id,governed_id) WHERE v.tenant_id=$1 AND v.governed_id=$2 AND v.version=$3',[input.tenantId,input.governedId,input.version]);if(!exists.rowCount)throw new Error('governed_version_not_found');if(exists.rows[0]!.owner_id===input.principalId)throw new Error('governed_self_approval_not_allowed');await client.query('INSERT INTO registry.governed_approvals(tenant_id,governed_id,version,approved_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.tenantId,input.governedId,input.version,input.principalId]);await client.query("INSERT INTO registry.governed_events(tenant_id,governed_id,version,event_type,principal_id) VALUES($1,$2,$3,'version_approved',$4)",[input.tenantId,input.governedId,input.version,input.principalId]);return{version:input.version};});
}
export async function getApprovedGovernedVersion(pool:Pool,input:{tenantId:string;governedId:string;version:number}):Promise<{version:number;status:'approved';plan:Record<string,unknown>;planHash:string}>{
 return withTenant(pool,input.tenantId,async(client)=>{const result=await client.query<{plan:Record<string,unknown>;plan_hash:string}>('SELECT v.plan,v.plan_hash FROM registry.governed_versions v JOIN registry.governed_approvals a USING(tenant_id,governed_id,version) WHERE v.tenant_id=$1 AND v.governed_id=$2 AND v.version=$3',[input.tenantId,input.governedId,input.version]);const row=result.rows[0];if(!row){const exists=await client.query('SELECT 1 FROM registry.governed_versions WHERE tenant_id=$1 AND governed_id=$2 AND version=$3',[input.tenantId,input.governedId,input.version]);throw new Error(exists.rowCount?'governed_version_not_approved':'governed_version_not_found');}return{version:input.version,status:'approved',plan:row.plan,planHash:row.plan_hash};});
}

export async function createDraftAgentVersion(
 pool:Pool,
 input:{tenantId:string;agentId:string;capabilities:string[];bindings:Record<string,unknown>},
):Promise<{version:number}>{
 if(input.capabilities.some(capability=>!capability.trim()))throw new Error('invalid_agent_capability');
 return withTenant(pool,input.tenantId,async(client)=>{
  const agent=await client.query<{active_version:number}>('SELECT active_version FROM registry.agents WHERE tenant_id=$1 AND agent_id=$2 FOR UPDATE',[input.tenantId,input.agentId]);
  if(!agent.rowCount)throw new Error('agent_not_found');
  const versions=await client.query<{version:number}>('SELECT COALESCE(MAX(version),0)::int AS version FROM registry.agent_versions WHERE tenant_id=$1 AND agent_id=$2',[input.tenantId,input.agentId]);
  const version=versions.rows[0]!.version+1;
  await client.query(`INSERT INTO registry.agent_versions(tenant_id,agent_id,version,capabilities,bindings,status)
   VALUES($1,$2,$3,$4::jsonb,$5::jsonb,'draft')`,[input.tenantId,input.agentId,version,JSON.stringify(input.capabilities),JSON.stringify(input.bindings)]);
  return{version};
 });
}

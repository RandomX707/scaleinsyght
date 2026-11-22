import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import type { EffectClass, EffectSafety } from '@scaleinsyght/contracts';

export type ConnectorType = 'sql_server' | 'postgres' | 'snowflake' | 'excel' | 'dbt' | 'tableau' | 'power_bi';

export interface ActivateConnectionInput {
  tenantId: string;
  principalId: string;
  connectorType: ConnectorType;
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

    const connectionId = randomUUID();
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
    await client.query(
      `INSERT INTO registry.connections
       (tenant_id, connection_id, connector_type, status, connector_agent_id, source_group_id, source_group_version)
       VALUES ($1, $2, $3, 'active', $4, $5, 1)`,
      [input.tenantId, connectionId, input.connectorType, agentId, sourceGroupId],
    );
    await client.query(
      `UPDATE registry.agents SET connection_id = $3 WHERE tenant_id = $1 AND agent_id = $2`,
      [input.tenantId, agentId, connectionId],
    );
    await client.query(
      `INSERT INTO registry.source_group_members (tenant_id, source_group_id, group_version, connection_id)
       VALUES ($1, $2, 1, $3)`,
      [input.tenantId, sourceGroupId, connectionId],
    );
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
 roleTemplate:'analyst'|'engineer'|'researcher'|'executive'|null;
 vocabulary:Record<string,string>;
 defaultSources:string[];
 savedPlanIds:string[];
 answerStyle:'concise'|'detailed'|'sql_first'|'lineage_first'|null;
}
export async function savePersonalMemory(pool:Pool,input:{tenantId:string;personId:string;memory:PersonalMemoryData}):Promise<void>{
 const memory=input.memory;
 if(Object.keys(memory.vocabulary).length>100||Object.entries(memory.vocabulary).some(([key,value])=>!key.trim()||key.length>120||value.length>500))throw new Error('invalid_personal_memory');
 if([...memory.defaultSources,...memory.savedPlanIds].some(id=>!/^\w[\w-]{0,127}$/.test(id)))throw new Error('invalid_personal_memory');
 await withTenant(pool,input.tenantId,async(client)=>{
  await client.query("SELECT set_config('app.principal_id',$1,true)",[input.personId]);
  await client.query(`INSERT INTO registry.personal_memories(tenant_id,person_id,role_template,vocabulary,default_sources,saved_plan_ids,answer_style)
   VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)
   ON CONFLICT(tenant_id,person_id) DO UPDATE SET role_template=EXCLUDED.role_template,vocabulary=EXCLUDED.vocabulary,
   default_sources=EXCLUDED.default_sources,saved_plan_ids=EXCLUDED.saved_plan_ids,answer_style=EXCLUDED.answer_style,updated_at=clock_timestamp()`,
   [input.tenantId,input.personId,memory.roleTemplate,JSON.stringify(memory.vocabulary),JSON.stringify(memory.defaultSources),JSON.stringify(memory.savedPlanIds),memory.answerStyle]);
 });
}
export async function readPersonalMemory(pool:Pool,input:{tenantId:string;personId:string}):Promise<PersonalMemoryData>{
 return withTenant(pool,input.tenantId,async(client)=>{
  await client.query("SELECT set_config('app.principal_id',$1,true)",[input.personId]);
  const result=await client.query<{role_template:PersonalMemoryData['roleTemplate'];vocabulary:Record<string,string>;default_sources:string[];saved_plan_ids:string[];answer_style:PersonalMemoryData['answerStyle']}>('SELECT role_template,vocabulary,default_sources,saved_plan_ids,answer_style FROM registry.personal_memories WHERE tenant_id=$1 AND person_id=$2',[input.tenantId,input.personId]);
  const row=result.rows[0];return row?{roleTemplate:row.role_template,vocabulary:row.vocabulary,defaultSources:row.default_sources,savedPlanIds:row.saved_plan_ids,answerStyle:row.answer_style}:{roleTemplate:null,vocabulary:{},defaultSources:[],savedPlanIds:[],answerStyle:null};
 });
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

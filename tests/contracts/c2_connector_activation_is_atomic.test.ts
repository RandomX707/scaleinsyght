import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection, registerCapability, createDraftAgentVersion } from '@scaleinsyght/registry';
import { validateCapabilityForPlan } from '@scaleinsyght/policy';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value);
  url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
  return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

async function createTenant(tenantId: string, allowance: number): Promise<string> {
  return withTenant(migrate, tenantId, async (client) => {
    await client.query('INSERT INTO core.tenants (tenant_id, name, connector_allowance) VALUES ($1, $1, $2)', [tenantId, allowance]);
    const user = await client.query<{ user_id: string }>(
      `INSERT INTO core.users (tenant_id, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
      [tenantId, `${tenantId}@synthetic.example`, 'synthetic-hash-only'],
    );
    return user.rows[0]!.user_id;
  });
}

describe('contract 2 connector activation', () => {
  afterAll(async () => {
    await app.end();
    await migrate.end();
  });

  it('c2_failed_connection_activation_leaves_no_agent_or_event', async () => {
    const tenantId = `activation-${crypto.randomUUID()}`;
    const userId = await createTenant(tenantId, 5);
    await expect(activateConnection(app, {
      tenantId, principalId: userId, connectorType: 'not-a-connector' as never,
    })).rejects.toThrow();

    const counts = await withTenant(migrate, tenantId, async (client) => client.query<{ agents: string; events: string; connections: string }>(
      `SELECT
         (SELECT count(*)::text FROM registry.agents WHERE tenant_id = $1) AS agents,
         (SELECT count(*)::text FROM registry.events WHERE tenant_id = $1) AS events,
         (SELECT count(*)::text FROM registry.connections WHERE tenant_id = $1) AS connections`,
      [tenantId],
    ));
    expect(counts.rows[0]).toEqual({ agents: '0', events: '0', connections: '0' });
  });

  it('c1_connector_over_allowance_rolls_back_activation_and_agent', async () => {
    const tenantId = `allowance-${crypto.randomUUID()}`;
    const userId = await createTenant(tenantId, 1);
    await activateConnection(app, { tenantId, principalId: userId, connectorType: 'postgres' });
    await expect(activateConnection(app, {
      tenantId, principalId: userId, connectorType: 'snowflake',
    })).rejects.toThrow('connector_allowance_exceeded');

    const counts = await withTenant(migrate, tenantId, async (client) => client.query<{ agents: string; events: string; connections: string }>(
      `SELECT
         (SELECT count(*)::text FROM registry.agents WHERE tenant_id = $1) AS agents,
         (SELECT count(*)::text FROM registry.events WHERE tenant_id = $1) AS events,
         (SELECT count(*)::text FROM registry.connections WHERE tenant_id = $1) AS connections`,
      [tenantId],
    ));
    expect(counts.rows[0]).toEqual({ agents: '1', events: '1', connections: '1' });
  });

  it('c2_registered_versions_are_immutable_and_release_one_action_effects_stay_disabled', async () => {
    const tenantId=`manifest-${crypto.randomUUID()}`;
    await createTenant(tenantId,3);
    await registerCapability(app,tenantId,{capabilityId:'synthetic.deploy',version:1,effectClass:'DEPLOY',effectSafety:'none',enabled:true,inputSchema:{type:'object'},outputSchema:{type:'object'}});
    const state=await withTenant(migrate,tenantId,async(client)=>{
      const capability=await client.query<{enabled:boolean}>('SELECT enabled FROM registry.capabilities WHERE capability_id=$1',['synthetic.deploy']);
      await expect(client.query(`UPDATE registry.capability_versions SET input_schema='{}'::jsonb WHERE capability_id=$1`,['synthetic.deploy'])).rejects.toThrow('registered versions are immutable');
      return capability.rows[0]?.enabled;
    });
    expect(state).toBe(false);
  });

  it('c2_approved_agent_edit_creates_immutable_draft_version',async()=>{
    const tenantId=`agent-version-${crypto.randomUUID()}`;const userId=await createTenant(tenantId,3);
    const connection=await activateConnection(app,{tenantId,principalId:userId,connectorType:'postgres'});
    const draft=await createDraftAgentVersion(app,{tenantId,agentId:connection.agentId,capabilities:['golden.read'],bindings:{label:'synthetic edit'}});
    expect(draft.version).toBe(2);
    const current=await withTenant(migrate,tenantId,async(client)=>{
      const agent=await client.query<{active_version:number}>('SELECT active_version FROM registry.agents WHERE agent_id=$1',[connection.agentId]);
      const versions=await client.query<{version:number;status:string;bindings:Record<string,unknown>}>('SELECT version,status,bindings FROM registry.agent_versions WHERE agent_id=$1 ORDER BY version',[connection.agentId]);
      await expect(client.query(`UPDATE registry.agent_versions SET bindings='{}'::jsonb WHERE agent_id=$1 AND version=1`,[connection.agentId])).rejects.toThrow('registered versions are immutable');
      return{active:agent.rows[0]?.active_version,versions:versions.rows};
    });
    expect(current.active).toBe(1);
    expect(current.versions.map(row=>row.status)).toEqual(['approved','draft']);
    expect(current.versions[0]?.bindings).toMatchObject({connection_id:connection.connectionId});
  });

  it('c2_unregistered_unpinned_or_disabled_capability_is_rejected',async()=>{
    const tenantId=`plan-capability-${crypto.randomUUID()}`;await createTenant(tenantId,2);
    await registerCapability(app,tenantId,{capabilityId:'golden.read',version:1,effectClass:'READ',effectSafety:'not_applicable',enabled:true,inputSchema:{type:'object'},outputSchema:{type:'object'}});
    await registerCapability(app,tenantId,{capabilityId:'synthetic.release',version:1,effectClass:'RELEASE',effectSafety:'none',enabled:true,inputSchema:{type:'object'},outputSchema:{type:'object'}});
    await expect(validateCapabilityForPlan(app,tenantId,'missing.capability',1)).rejects.toThrow('capability_not_registered');
    await expect(validateCapabilityForPlan(app,tenantId,'golden.read',2)).rejects.toThrow('capability_version_not_pinned');
    await expect(validateCapabilityForPlan(app,tenantId,'synthetic.release',1)).rejects.toThrow('capability_effect_disabled');
    await expect(validateCapabilityForPlan(app,tenantId,'golden.read',1)).resolves.toMatchObject({capabilityId:'golden.read',version:1});
  });
});

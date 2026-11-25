import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { withTenant } from '@scaleinsyght/db';
import { authorise } from '@scaleinsyght/policy';
import { retireConnection, runIdAgent } from '@scaleinsyght/profiler';
import { createPostgresConnector } from '@scaleinsyght/connectors';
import { activateConnection, checkStepAgent, CONNECTOR_AGENT_CAPABILITIES } from '@scaleinsyght/registry';
import { addRunStep, claimNextStep, createRun, eventsAfter, failStep, transitionRun } from '@scaleinsyght/runner';
import { createTenant } from '../../scripts/tenant-create.js';
import { buildTestServer } from '../support/test-api.js';

// Decision 52: agents are checked when a step runs, not only when a plan is made. Real PostgreSQL; nothing mocked.
config({ path: '.env' });
const testUrl = (key: 'DATABASE_URL' | 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; agent contracts are never skipped`); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); };
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const worker = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });
const volume = mkdtempSync(join(tmpdir(), 'si-agents-'));
const store = new EncryptedArtifactStore(volume, Buffer.alloc(32, 61));
const password = 'agents-contract-password-2026';
let tenantId = ''; let principal = '';

/** A running run with one step for the connector agent, claimed the way the worker claims it. */
async function claimedStep(capabilityId = 'analytic.read') {
  const connection = await activateConnection(app, { tenantId, principalId: principal, connectorType: 'excel' });
  const run = await createRun(migrate, { tenantId, principalId: principal });
  const stepId = await addRunStep(migrate, { tenantId, runId: run.runId, capabilityId, capabilityVersion: 1, agentId: connection.agentId, stepOrder: 1 });
  for (const to of ['PLANNING', 'PLAN_VALIDATED', 'RUNNING'] as const) await transitionRun(migrate, { tenantId, runId: run.runId, to });
  const claim = await claimNextStep(worker, 'agent-contract-worker', 60_000, tenantId);
  expect(claim?.stepId).toBe(stepId);
  return { connection, runId: run.runId, claim: claim! };
}
/** What the worker does with a failed check: the step fails with the check's reason. */
async function runAsWorker(step: Awaited<ReturnType<typeof claimedStep>>) {
  const check = await checkStepAgent(worker, { runId: step.runId, stepId: step.claim.stepId, sourceId: step.connection.connectionId });
  if (!check.ok) await failStep(worker, step.claim, { reasonCode: check.reason });
  const failed = (await eventsAfter(migrate, tenantId, step.runId, 0)).filter((event) => event.event_type === 'step_failed');
  return { check, failedReasons: failed.flatMap((event) => (event.safe_payload as { reason_codes?: string[] }).reason_codes ?? []) };
}

describe('contract 2 agents at execution time', () => {
  beforeAll(async () => {
    tenantId = `agents-${randomUUID()}`;
    principal = (await createTenant(migrate, { tenantId, name: 'Agents workspace', displayName: 'Agent Tester', email: `owner@${tenantId}.test.invalid`, password })).userId;
  });
  afterAll(async () => { await app.end(); await worker.end(); await migrate.end(); rmSync(volume, { recursive: true, force: true }); });

  it('c2_connector_agents_get_explicit_capabilities_and_tenants_get_id_agents', async () => {
    const connection = await activateConnection(app, { tenantId, principalId: principal, connectorType: 'excel' });
    const rows = await withTenant(migrate, tenantId, async (db) => ({
      connector: (await db.query<{ capabilities: string[] }>('SELECT v.capabilities FROM registry.agents a JOIN registry.agent_versions v ON v.tenant_id=a.tenant_id AND v.agent_id=a.agent_id AND v.version=a.active_version WHERE a.tenant_id=$1 AND a.agent_id=$2', [tenantId, connection.agentId])).rows[0]!.capabilities,
      tenantAgents: (await db.query<{ agent_type: string; capabilities: string[] }>("SELECT a.agent_type,v.capabilities FROM registry.agents a JOIN registry.agent_versions v ON v.tenant_id=a.tenant_id AND v.agent_id=a.agent_id AND v.version=a.active_version WHERE a.tenant_id=$1 AND a.agent_type IN ('id','id_trace') ORDER BY 1", [tenantId])).rows,
    }));
    expect(rows.connector).toEqual([...CONNECTOR_AGENT_CAPABILITIES]);
    expect(rows.tenantAgents).toEqual([
      { agent_type: 'id', capabilities: ['id.detect', 'id.fingerprint', 'id.match'] },
      { agent_type: 'id_trace', capabilities: ['id.trace', 'id.lookup'] },
    ]);
  });

  it('c2_an_active_agent_with_the_capability_runs_and_its_decision_names_the_agent', async () => {
    const step = await claimedStep();
    const check = await checkStepAgent(worker, { runId: step.runId, stepId: step.claim.stepId, sourceId: step.connection.connectionId });
    expect(check).toMatchObject({ ok: true, agentId: step.connection.agentId });
    const decision = await authorise(app, { principal: { tenant_id: tenantId, principal_id: principal, kind: 'user', roles: [], groups: [], attributes: {} }, capability_id: 'analytic.read', resources: [step.connection.connectionId], purpose: 'analytic_query', environment: 'production' }, step.runId, step.connection.agentId);
    const stored = await withTenant(migrate, tenantId, (db) => db.query<{ agent_id: string }>('SELECT agent_id FROM runs.authz_decisions WHERE tenant_id=$1 AND decision_id=$2', [tenantId, decision.decision_id]));
    expect(stored.rows[0]?.agent_id).toBe(step.connection.agentId);
  });

  it('c2_a_step_fails_when_its_agent_is_retired_after_planning', async () => {
    const step = await claimedStep();
    await withTenant(migrate, tenantId, (db) => db.query("UPDATE registry.agents SET status='retired' WHERE tenant_id=$1 AND agent_id=$2", [tenantId, step.connection.agentId]));
    const result = await runAsWorker(step);
    expect(result.check).toMatchObject({ ok: false, reason: 'agent_not_active' });
    expect(result.failedReasons).toEqual(['agent_not_active']);
  });

  it('c2_a_step_fails_when_its_connection_is_removed_after_planning', async () => {
    const step = await claimedStep();
    await retireConnection(app, store, { tenantId, connectionId: step.connection.connectionId, principalId: principal });
    const result = await runAsWorker(step);
    expect(result.check).toMatchObject({ ok: false, reason: 'connection_not_active' });
    expect(result.failedReasons).toEqual(['connection_not_active']);
  });

  it('c2_a_step_fails_when_the_capability_is_not_in_the_agents_version', async () => {
    const step = await claimedStep('report.export');
    const result = await runAsWorker(step);
    expect(result.check).toMatchObject({ ok: false, reason: 'agent_capability_missing' });
    expect(result.failedReasons).toEqual(['agent_capability_missing']);
  });

  it('c2_id_agent_runs_are_logged_against_the_tenants_id_agent', async () => {
    const connection = await activateConnection(app, { tenantId, principalId: principal, connectorType: 'postgres' });
    const sample = process.env.DATABASE_URL_SAMPLE_SOURCE; if (!sample) throw new Error('DATABASE_URL_SAMPLE_SOURCE is required; run pnpm db:setup:sample');
    const connector = createPostgresConnector({ connectionString: sample, name: 'Sample' });
    try { await runIdAgent(app, { tenantId, connectionId: connection.connectionId, connector, masterKey: Buffer.alloc(32, 11) }); } finally { await connector.close(); }
    const runs = await withTenant(migrate, tenantId, (db) => db.query<{ connection_id: string; safe_payload: Record<string, unknown> }>(
      "SELECT e.connection_id,e.safe_payload FROM registry.events e JOIN registry.agents a ON a.tenant_id=e.tenant_id AND a.agent_id=e.agent_id WHERE e.tenant_id=$1 AND e.event_type='agent_run' AND a.agent_type='id'", [tenantId]));
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ connection_id: connection.connectionId, safe_payload: { action: 'detect_and_match' } });
  });

  it('c2_id_trace_runs_are_logged_against_the_id_trace_agent_without_values', async () => {
    const server = await buildTestServer({ pool: app, sessionSecret: 'agents-contract-secret-0123456789abcdefghijkl', testAccounts: [{ tenantId, email: `owner@${tenantId}.test.invalid` }] });
    try {
      const cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email: `owner@${tenantId}.test.invalid`, password } })).headers['set-cookie']).split(';')[0]!;
      expect((await server.inject({ method: 'GET', url: '/api/ids/entities', headers: { cookie } })).statusCode).toBe(200);
      process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
      expect((await server.inject({ method: 'POST', url: '/api/ids/lookup', headers: { cookie }, payload: { value: 'SYNTHETIC-ID-7731' } })).statusCode).toBe(200);
      const runs = await withTenant(migrate, tenantId, (db) => db.query<{ safe_payload: Record<string, unknown> }>(
        "SELECT e.safe_payload FROM registry.events e JOIN registry.agents a ON a.tenant_id=e.tenant_id AND a.agent_id=e.agent_id WHERE e.tenant_id=$1 AND e.event_type='agent_run' AND a.agent_type='id_trace' ORDER BY e.created_at", [tenantId]));
      expect(runs.rows.map((row) => row.safe_payload.action)).toEqual(['list', 'lookup']);
      expect(JSON.stringify(runs.rows)).not.toContain('SYNTHETIC-ID-7731');
    } finally { await server.close(); }
  });
});

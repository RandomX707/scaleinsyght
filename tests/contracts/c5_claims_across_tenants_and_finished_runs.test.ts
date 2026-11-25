import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { addRunStep, claimNextStep, completeStep, createRun, eventsAfter, transitionRun, type StepClaim } from '@scaleinsyght/runner';

// Contract 5, as in production: one queue holding several tenants' steps, workers that claim across all tenants, and
// runs that end while their steps are still open. Real PostgreSQL; nothing is mocked.
config({ path: '.env' });
function testUrl(key: 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString();
}
const workerA = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER'), max: 2 });
const workerB = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER'), max: 2 });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE'), max: 2 });

async function tenantWithAgent(prefix: string): Promise<{ tenant: string; principal: string; agent: string }> {
  const tenant = `${prefix}-${randomUUID()}`; let principal = ''; let agent = '';
  await withTenant(migrate, tenant, async (db) => {
    await db.query('INSERT INTO core.tenants (tenant_id,name) VALUES ($1,$1)', [tenant]);
    principal = (await db.query<{ user_id: string }>(`INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id`, [tenant, `${tenant}@synthetic.example`])).rows[0]!.user_id;
    agent = (await db.query<{ agent_id: string }>(`INSERT INTO registry.agents(tenant_id,agent_type,status,owner_id) VALUES($1,'connector','active',$2) RETURNING agent_id`, [tenant, principal])).rows[0]!.agent_id;
  });
  return { tenant, principal, agent };
}
async function runningRun(owner: { tenant: string; principal: string; agent: string }, steps: number): Promise<{ runId: string; stepIds: string[] }> {
  const run = await createRun(migrate, { tenantId: owner.tenant, principalId: owner.principal });
  const stepIds: string[] = [];
  for (let order = 1; order <= steps; order++) stepIds.push(await addRunStep(migrate, { tenantId: owner.tenant, runId: run.runId, capabilityId: 'golden.read', capabilityVersion: 1, agentId: owner.agent, stepOrder: order }));
  for (const to of ['PLANNING', 'PLAN_VALIDATED', 'RUNNING'] as const) await transitionRun(migrate, { tenantId: owner.tenant, runId: run.runId, to });
  return { runId: run.runId, stepIds };
}

describe('contract 5 claims across tenants and finished runs', () => {
  afterAll(async () => { await workerA.end(); await workerB.end(); await migrate.end(); });

  it('c5_two_workers_on_a_mixed_tenant_queue_claim_every_step_exactly_once', async () => {
    const owners = await Promise.all(['queue-a', 'queue-b', 'queue-c'].map(tenantWithAgent));
    const runs = [];
    for (const owner of owners) for (let index = 0; index < 3; index++) runs.push({ owner, ...await runningRun(owner, 4) });
    const ours = new Set(runs.flatMap((run) => run.stepIds));
    expect(ours.size).toBe(36);
    // Both workers claim across all tenants, as production workers do, completing what they claim.
    const claimed: StepClaim[] = [];
    const work = async (pool: Pool, workerId: string) => {
      for (let idle = 0; idle < 3 && [...ours].some((id) => !claimed.some((claim) => claim.stepId === id));) {
        const claim = await claimNextStep(pool, workerId, 60_000);
        if (!claim) { idle++; continue; }
        claimed.push(claim);
        if (ours.has(claim.stepId)) await expect(completeStep(pool, claim, { resultRef: `golden://queue/${claim.stepId}` })).resolves.toBe(true);
      }
    };
    await Promise.all([work(workerA, 'queue-worker-a'), work(workerB, 'queue-worker-b')]);
    const mine = claimed.filter((claim) => ours.has(claim.stepId));
    expect(mine).toHaveLength(36);
    expect(new Set(mine.map((claim) => claim.stepId)).size).toBe(36);
    // Each claim kept its own tenant, both workers took part, and every step has exactly one claim event.
    for (const claim of mine) expect(runs.find((run) => run.runId === claim.runId)?.owner.tenant).toBe(claim.tenantId);
    expect(new Set(mine.map((claim) => claim.workerId)).size).toBe(2);
    for (const run of runs) {
      const events = await eventsAfter(migrate, run.owner.tenant, run.runId, 0);
      expect(events.filter((event) => event.event_type === 'step_claimed').map((event) => event.step_id).sort()).toEqual([...run.stepIds].sort());
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      expect(events.at(-1)?.event_type).toBe('run_terminal');
    }
  });

  it('c5_steps_of_completed_failed_or_cancelled_runs_are_never_claimed', async () => {
    const owner = await tenantWithAgent('finished-runs');
    const completed = await runningRun(owner, 2);
    // Completed with a step still open: finalise without finishing the second step.
    for (const to of ['FINALISING', 'COMPLETED'] as const) await transitionRun(migrate, { tenantId: owner.tenant, runId: completed.runId, to });
    const failed = await runningRun(owner, 1);
    await transitionRun(migrate, { tenantId: owner.tenant, runId: failed.runId, to: 'FAILED' });
    const cancelled = await runningRun(owner, 1);
    // A step claimed before the run was cancelled, whose lease then expired, is not taken again either.
    const before = await claimNextStep(workerA, 'before-cancel', 60_000, owner.tenant);
    // The completed and failed runs' open steps are already out of the queue, so this takes the cancelled run's step.
    expect(before?.runId).toBe(cancelled.runId);
    await transitionRun(migrate, { tenantId: owner.tenant, runId: cancelled.runId, to: 'CANCELLED' });
    await withTenant(migrate, owner.tenant, (db) => db.query(`UPDATE runs.steps SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`, [cancelled.runId]));
    const active = await runningRun(owner, 1);
    const finished = new Set([...completed.stepIds, ...failed.stepIds, ...cancelled.stepIds]);

    // Scoped to the tenant: only the active run's step is claimable, then nothing.
    const claims: Array<StepClaim | null> = [];
    for (let index = 0; index < 4; index++) claims.push(await claimNextStep(workerB, `scoped-${index}`, 60_000, owner.tenant));
    expect(claims.filter(Boolean).map((claim) => claim!.stepId)).toEqual(active.stepIds);
    // Unscoped, as production workers claim: whatever else the shared queue holds, no finished run's step comes back.
    for (let index = 0; index < 50; index++) {
      const claim = await claimNextStep(workerA, `unscoped-${index}`, 60_000);
      if (!claim) break;
      expect(finished.has(claim.stepId), claim.stepId).toBe(false);
    }
    // The database enforces it too: in claim mode the worker cannot see those steps at all.
    const visible = await (async () => {
      const client = await workerA.connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT set_config('app.worker_claim','enabled',true)");
        const rows = await client.query<{ step_id: string }>('SELECT step_id FROM runs.steps WHERE step_id=ANY($1::uuid[])', [[...finished]]);
        await client.query('ROLLBACK'); return rows.rows.length;
      } finally { client.release(); }
    })();
    expect(visible).toBe(0);
    const open = await withTenant(migrate, owner.tenant, (db) => db.query<{ count: string }>("SELECT count(*)::text AS count FROM runs.steps WHERE step_id=ANY($1::uuid[]) AND state IN ('PENDING','CLAIMED')", [[...finished]]));
    expect(Number(open.rows[0]!.count)).toBeGreaterThan(0);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant, withRunTenant } from '@scaleinsyght/db';

config({ path: '.env' });

function testUrl(key: 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value);
  url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
  return url.toString();
}

const worker = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER'), max: 2 });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE'), max: 1 });

describe('contract 1 worker tenancy', () => {
  afterAll(async () => {
    await worker.end();
    await migrate.end();
  });

  it('c1_forged_job_tenant_uses_stored_run_tenant', async () => {
    const tenantId = `worker-${crypto.randomUUID()}`;
    let runId = '';
    await withTenant(migrate, tenantId, async (client) => {
      await client.query('INSERT INTO core.tenants (tenant_id, name) VALUES ($1, $1)', [tenantId]);
      const user = await client.query<{ user_id: string }>(
        `INSERT INTO core.users (tenant_id, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
        [tenantId, `${tenantId}@synthetic.example`, 'not-a-real-password-hash'],
      );
      const run = await client.query<{ run_id: string }>(
        `INSERT INTO runs.runs (tenant_id, principal_id, state) VALUES ($1, $2, 'CREATED') RETURNING run_id`,
        [tenantId, user.rows[0]!.user_id],
      );
      runId = run.rows[0]!.run_id;
    });

    const jobPayload = { run_id: runId, tenant_id: 'forged-tenant' };
    const observedTenant = await withRunTenant(worker, jobPayload.run_id, async (client, run) => {
      const visible = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM core.tenants');
      expect(run.tenant_id).toBe(tenantId);
      expect(visible.rows.map((row) => row.tenant_id)).toEqual([tenantId]);
      return run.tenant_id;
    });
    expect(observedTenant).toBe(tenantId);
  });
});

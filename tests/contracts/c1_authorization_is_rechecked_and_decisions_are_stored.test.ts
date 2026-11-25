import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { authorise } from '@scaleinsyght/policy';
import { withTenant } from '@scaleinsyght/db';

config({ path: '.env' });
const testUrl = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value);
  url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
  return url.toString();
};
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

describe('contract 1 per-call authorization', () => {
  afterAll(async () => {
    await app.end();
    await migrate.end();
  });

  it('c1_revocation_blocks_next_run_step_and_each_call_has_one_decision', async () => {
    const tenantId = `policy-${crypto.randomUUID()}`;
    const email = `${tenantId}@synthetic.example`;
    let userId = '';
    await withTenant(migrate, tenantId, async (client) => {
      await client.query('INSERT INTO core.tenants (tenant_id, name) VALUES ($1, $1)', [tenantId]);
      const user = await client.query<{ user_id: string }>(
        `INSERT INTO core.users (tenant_id, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
        [tenantId, email, 'synthetic-hash-only'],
      );
      userId = user.rows[0]!.user_id;
      await client.query(
        `INSERT INTO registry.capabilities (tenant_id, capability_id, active_version, effect_class, effect_safety, enabled)
         VALUES ($1, 'catalog.read', 1, 'READ', 'not_applicable', true)`, [tenantId],
      );
      await client.query(
        `INSERT INTO registry.capability_versions (tenant_id, capability_id, version, input_schema, output_schema)
         VALUES ($1, 'catalog.read', 1, '{}'::jsonb, '{}'::jsonb)`, [tenantId],
      );
      await client.query(
        `INSERT INTO core.entitlements (tenant_id, principal_id, capability_id, resource_id)
         VALUES ($1, $2, 'catalog.read', 'golden-asset')`, [tenantId, userId],
      );
    });

    const request = {
      principal: { tenant_id: tenantId, principal_id: userId, kind: 'user' as const, roles: ['admin'], groups: [], attributes: {} },
      capability_id: 'catalog.read', resources: ['golden-asset'], purpose: 'catalogue', environment: 'local',
    };
    const first = await authorise(app, request);
    expect(first.outcome).toBe('allow');

    await withTenant(migrate, tenantId, async (client) => {
      await client.query(
        `UPDATE core.entitlements SET allowed = false WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = 'catalog.read'`,
        [tenantId, userId],
      );
    });
    const next = await authorise(app, request);
    expect(next.outcome).toBe('deny');

    const decisions = await withTenant(migrate, tenantId, async (client) => client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM runs.authz_decisions WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = 'catalog.read'`,
      [tenantId, userId],
    ));
    expect(decisions.rows[0]?.count).toBe('2');
  });
});

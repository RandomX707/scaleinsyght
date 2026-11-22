import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { getUsage, withTenant } from '@scaleinsyght/db';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value);
  url.pathname = '/si_test';
  return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

describe('contract 1 usage accounting', () => {
  afterAll(async () => {
    await app.end();
    await migrate.end();
  });

  it('c1_usage_recount_matches_activity_event_log', async () => {
    const tenantId = `usage-${crypto.randomUUID()}`;
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const activeConnector = crypto.randomUUID();
    const retiredConnector = crypto.randomUUID();
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 60_000);

    await withTenant(migrate, tenantId, async (client) => {
      await client.query('INSERT INTO core.tenants (tenant_id, name) VALUES ($1, $1)', [tenantId]);
      await client.query(
        `INSERT INTO core.activity_events (tenant_id, event_type, principal_id, occurred_at) VALUES
         ($1, 'user_active', $2, $4), ($1, 'user_active', $3, $4), ($1, 'user_active', $2, $4)`,
        [tenantId, userA, userB, from],
      );
      await client.query(
        `INSERT INTO core.activity_events (tenant_id, event_type, connector_id, connector_type, occurred_at) VALUES
         ($1, 'connector_activated', $2, 'postgres', $4),
         ($1, 'connector_activated', $3, 'snowflake', $4),
         ($1, 'connector_retired', $3, 'snowflake', $5)`,
        [tenantId, activeConnector, retiredConnector, from, to],
      );
    });

    const usage = await getUsage(app, tenantId, from, new Date(to.getTime() + 60_000));
    expect(usage.active_users).toBe(2);
    expect(usage.active_connectors.by_type).toEqual({ postgres: 1 });
    expect(usage.computed_from_event_ids_range.first).toBeTruthy();
    expect(usage.computed_from_event_ids_range.last).toBeTruthy();
  });
});

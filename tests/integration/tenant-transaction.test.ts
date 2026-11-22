import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { createPool, withTenant } from '@scaleinsyght/db';

config({ path: '.env' });
const pool = createPool('DATABASE_URL');

describe('tenant transaction context on PostgreSQL 16', () => {
  afterAll(async () => pool.end());

  it('c1_set_local_tenant_context_does_not_leak_across_pooled_transactions', async () => {
    const tenantId = `pool-${crypto.randomUUID()}`;
    const inside = await withTenant(pool, tenantId, async (client) => {
      const result = await client.query<{ tenant_id: string }>(
        `SELECT current_setting('app.tenant_id', true) AS tenant_id`,
      );
      return result.rows[0]?.tenant_id;
    });
    expect(inside).toBe(tenantId);

    const outside = await pool.query<{ tenant_id: string | null }>(
      `SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant_id`,
    );
    expect(outside.rows[0]?.tenant_id).toBeNull();
  });
});

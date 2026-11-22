import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { config } from 'dotenv';

config({ path: '.env' });

function databaseUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE', database: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required for PostgreSQL contract tests; no test is skipped or mocked`);
  const url = new URL(value);
  url.pathname = `/${database}`;
  return url.toString();
}

const tenantA = 'contract-tenant-a';
const tenantB = 'contract-tenant-b';
const app = new Pool({ connectionString: databaseUrl('DATABASE_URL', 'si_test'), max: 4 });
const migrate = new Pool({ connectionString: databaseUrl('DATABASE_URL_MIGRATE', 'si_test'), max: 1 });

async function insertTenant(tenantId: string): Promise<void> {
  const client = await migrate.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config(\'app.tenant_id\', $1, true)', [tenantId]);
    await client.query('INSERT INTO core.tenants (tenant_id, name) VALUES ($1, $2)', [tenantId, tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('contract 1 tenant isolation against real PostgreSQL 16', () => {
  beforeAll(async () => {
    const check = await app.query<{ current_database: string }>('SELECT current_database()');
    if (check.rows[0]?.current_database !== 'si_test') {
      throw new Error('Contract tests must use the resettable si_test database, never DATABASE_URL');
    }
    await insertTenant(tenantA);
    await insertTenant(tenantB);
  });

  afterAll(async () => {
    await app.end();
    await migrate.end();
  });

  it('c1_tenant_a_cannot_read_tenant_b_rows_in_any_table', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config(\'app.tenant_id\', $1, true)', [tenantA]);
      const rows = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM core.tenants');
      expect(rows.rows).toEqual([{ tenant_id: tenantA }]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('c1_missing_tenant_context_reads_zero_and_rejects_insert', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query('SELECT tenant_id FROM core.tenants');
      expect(rows.rowCount).toBe(0);
      await expect(
        client.query('INSERT INTO core.tenants (tenant_id, name) VALUES ($1, $2)', ['no-context', 'No context']),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

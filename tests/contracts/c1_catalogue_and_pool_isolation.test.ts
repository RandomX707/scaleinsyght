import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';

config({ path: '.env' });

function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value);
  url.pathname = '/si_test';
  return url.toString();
}

const app = new Pool({ connectionString: testUrl('DATABASE_URL'), max: 4 });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE'), max: 1 });

describe('contract 1 PostgreSQL catalogue and pooled isolation', () => {
  afterAll(async () => {
    await app.end();
    await migrate.end();
  });

  it('c1_runtime_roles_and_all_tenant_tables_force_rls', async () => {
    const tables = await migrate.query<{
      schema_name: string;
      table_name: string;
      has_tenant_id: boolean;
      row_security: boolean;
      force_row_security: boolean;
      owner: string;
    }>(`
      SELECT n.nspname AS schema_name, c.relname AS table_name,
             bool_or(a.attname = 'tenant_id') AS has_tenant_id,
             c.relrowsecurity AS row_security,
             c.relforcerowsecurity AS force_row_security,
             pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname IN ('core', 'registry', 'runs') AND c.relkind IN ('r', 'p')
      GROUP BY n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner
      ORDER BY n.nspname, c.relname
    `);
    expect(tables.rows.length).toBeGreaterThan(0);
    for (const table of tables.rows) {
      expect(table.has_tenant_id, `${table.schema_name}.${table.table_name} tenant_id`).toBe(true);
      expect(table.row_security, `${table.schema_name}.${table.table_name} RLS`).toBe(true);
      expect(table.force_row_security, `${table.schema_name}.${table.table_name} FORCE RLS`).toBe(true);
      expect(table.owner, `${table.schema_name}.${table.table_name} owner`).toBe('si_migrate');
    }

    const roles = await migrate.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('si_app', 'si_worker') ORDER BY rolname`,
    );
    expect(roles.rows).toEqual([
      { rolname: 'si_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'si_worker', rolsuper: false, rolbypassrls: false },
    ]);
    expect(tables.rows.some((table) => table.owner === 'si_app' || table.owner === 'si_worker')).toBe(false);
    const memberships = await migrate.query(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname IN ('si_app','si_worker')`,
    );
    expect(memberships.rowCount).toBe(0);
  });

  it('c1_interleaved_pool_requests_never_cross_tenants', async () => {
    const tenantA = `pool-a-${crypto.randomUUID()}`;
    const tenantB = `pool-b-${crypto.randomUUID()}`;
    await withTenant(migrate, tenantA, async (client) => {
      await client.query('INSERT INTO core.tenants (tenant_id, name) VALUES ($1, $1)', [tenantA]);
    });
    await withTenant(migrate, tenantB, async (client) => {
      await client.query('INSERT INTO core.tenants (tenant_id, name) VALUES ($1, $1)', [tenantB]);
    });

    const results = await Promise.all(Array.from({ length: 1_000 }, (_, index) => {
      const expected = index % 2 === 0 ? tenantA : tenantB;
      return withTenant(app, expected, async (client) => {
        const result = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM core.tenants ORDER BY tenant_id');
        return { expected, tenants: result.rows.map((row) => row.tenant_id) };
      });
    }));
    expect(results.every((result) => result.tenants.length === 1 && result.tenants[0] === result.expected)).toBe(true);
  });
});

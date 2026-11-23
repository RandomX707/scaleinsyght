import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';

config({ path: '.env' });

function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped or mocked`);
  const url = new URL(value);
  url.pathname = '/si_test';
  return url.toString();
}

const app = new Pool({ connectionString: testUrl('DATABASE_URL'), max: 2 });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE'), max: 1 });
const tables = [
  'adapters', 'adapter_versions', 'certified_metrics', 'metric_results', 'flowspecs',
  'flowspec_versions', 'flowspec_approvals', 'handoff_grants', 'handoffs',
];

describe('contract 1 Hub integration persistence', () => {
  afterAll(async () => {
    await app.end();
    await migrate.end();
  });

  it('c1_hub_adapters_and_metrics_are_tenant_scoped_with_forced_rls', async () => {
    const catalogue = await migrate.query<{ table_name: string; has_tenant_id: boolean; rls: boolean; force_rls: boolean; owner: string }>(`
      SELECT c.relname AS table_name,
        bool_or(a.attname='tenant_id') AS has_tenant_id,
        c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
        pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='hub' AND c.relkind='r' GROUP BY c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner
    `);
    expect(catalogue.rows.map((row) => row.table_name).sort()).toEqual([...tables].sort());
    for (const table of catalogue.rows) {
      expect(table.has_tenant_id, table.table_name).toBe(true);
      expect(table.rls, table.table_name).toBe(true);
      expect(table.force_rls, table.table_name).toBe(true);
      expect(table.owner, table.table_name).toBe('si_migrate');
    }

    const tenantA = `hub-a-${crypto.randomUUID()}`;
    const tenantB = `hub-b-${crypto.randomUUID()}`;
    for (const tenantId of [tenantA, tenantB]) {
      await withTenant(migrate, tenantId, async (client) => {
        await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
        await client.query(`INSERT INTO hub.adapters(tenant_id,product,connected,current_version) VALUES($1,'semantics',true,1)`, [tenantId]);
        await client.query(`INSERT INTO hub.adapter_versions(tenant_id,product,version,fixture_key,capabilities) VALUES($1,'semantics',1,'semantics-v1','[]'::jsonb)`, [tenantId]);
      });
    }
    const visible = await withTenant(app, tenantA, (client) => client.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM hub.adapters WHERE product='semantics' ORDER BY tenant_id`,
    ));
    expect(visible.rows).toEqual([{ tenant_id: tenantA }]);
  });
});

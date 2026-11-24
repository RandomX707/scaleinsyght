import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

config({ path: '.env' });
const url = process.env.DATABASE_URL_TESTBED;
if (!url) throw new Error('DATABASE_URL_TESTBED is required; run pnpm testbed:up. PostgreSQL contract tests are never skipped.');
const client = new Client({ connectionString: url });
const truth = JSON.parse(readFileSync('testbed/truth.json', 'utf8')) as {
  rowCounts: Record<string, number>;
  columnCounts: Record<string, number>;
  foreignKeys: Array<{ from: string; to: string }>;
  sensitiveColumns: string[];
};

describe('contract 6 isolated real PostgreSQL testbed', () => {
  afterAll(async () => { await client.end(); });

  it('c6_testbed_postgres_is_synthetic_read_only_and_contains_declared_and_undeclared_relationships', async () => {
    await client.connect();
    const database = await client.query<{ name: string; version: number }>(`SELECT current_database() AS name, current_setting('server_version_num')::integer AS version`);
    expect(database.rows[0]?.name).toBe('si_testbed_pg');
    expect(database.rows[0]!.version).toBeGreaterThanOrEqual(160000);
    expect(database.rows[0]!.version).toBeLessThan(170000);
    const counts = await client.query<{ total: string }>(`SELECT
      (SELECT count(*) FROM public.patients) + (SELECT count(*) FROM public.encounters) +
      (SELECT count(*) FROM public.orders) + (SELECT count(*) FROM public.departments) +
      (SELECT count(*) FROM public.providers) AS total`);
    expect(Number(counts.rows[0]?.total)).toBeGreaterThanOrEqual(2_000);
    for (const [table, expected] of Object.entries(truth.rowCounts)) {
      const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public."${table}"`);
      expect(Number(count.rows[0]?.count)).toBe(expected);
    }
    const objects = await client.query<{ views: number; functions: number; foreign_keys: number }>(`SELECT
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v') AS views,
      (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f') AS functions,
      (SELECT count(*)::integer FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND f.contype='f') AS foreign_keys`);
    expect(objects.rows[0]).toEqual({ views: 2, functions: 2, foreign_keys: 2 });
    const actualForeignKeys = await client.query<{ from: string; to: string }>(`SELECT local_table.relname || '.' || local_column.attname AS "from",
      target_table.relname || '.' || target_column.attname AS "to"
      FROM pg_constraint fk JOIN pg_class local_table ON local_table.oid=fk.conrelid
      JOIN pg_attribute local_column ON local_column.attrelid=fk.conrelid AND local_column.attnum=fk.conkey[1]
      JOIN pg_class target_table ON target_table.oid=fk.confrelid
      JOIN pg_attribute target_column ON target_column.attrelid=fk.confrelid AND target_column.attnum=fk.confkey[1]
      WHERE fk.contype='f' ORDER BY 1,2`);
    expect(actualForeignKeys.rows).toEqual(truth.foreignKeys);
    const actualColumns = await client.query<{ table_name: string; count: number }>(`SELECT table_name,count(*)::integer AS count FROM information_schema.columns
      WHERE table_schema='public' AND table_name=ANY($1::text[]) GROUP BY table_name ORDER BY table_name`, [Object.keys(truth.columnCounts)]);
    expect(Object.fromEntries(actualColumns.rows.map((row) => [row.table_name, row.count]))).toEqual(truth.columnCounts);
    const actualSensitive = await client.query<{ key: string }>(`SELECT c.relname || '.' || a.attname AS key FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      JOIN pg_description d ON d.objoid=c.oid AND d.objsubid=a.attnum
      WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND d.description LIKE 'sensitivity:%' ORDER BY key`);
    expect(actualSensitive.rows.map((row) => row.key)).toEqual(truth.sensitiveColumns);
    const grants = await client.query<{ can_create_db: boolean; can_create_schema: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean; is_superuser: boolean; can_create_role: boolean }>(`SELECT
      has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_db,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema,
      has_table_privilege(current_user, 'public.patients', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'public.patients', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'public.patients', 'DELETE') AS can_delete,
      rolsuper AS is_superuser, rolcreaterole AS can_create_role
      FROM pg_roles WHERE rolname=current_user`);
    expect(grants.rows[0]).toEqual({ can_create_db: false, can_create_schema: false, can_insert: false, can_update: false, can_delete: false, is_superuser: false, can_create_role: false });
    await expect(client.query("INSERT INTO public.departments(department_id, department_code, department_name) VALUES (9999, 'D-9999', 'Forbidden')")).rejects.toThrow();
  });
});

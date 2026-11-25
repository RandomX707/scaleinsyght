import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { PostgresConnector } from '@scaleinsyght/connectors';

config({ path: '.env' });
function adminConnection(): string {
  const configured = process.env.DATABASE_URL_ADMIN;
  const url = configured ? new URL(configured) : new URL('postgresql://127.0.0.1:5432/postgres');
  if (!configured) { url.username = process.env.USER ?? process.env.LOGNAME ?? ''; url.password = ''; }
  url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
  return url.toString();
}
const admin = new Client({ connectionString: adminConnection() });
const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
const schema = `c2_ro_${nonce}`;
const reader = `c2_reader_${nonce}`;
const writer = `c2_writer_${nonce}`;
const elevated = `c2_elevated_${nonce}`;
const password = randomUUID();
const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const hostUrl = new URL(adminConnection());
hostUrl.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
const urlFor = (role: string) => {
  const url = new URL(hostUrl.toString()); url.username = role; url.password = password; return url.toString();
};
let adminConnected = false;

describe('contract 2 PostgreSQL activation safety', () => {
  afterAll(async () => {
    await Promise.all(connectors.map((connector) => connector.close()));
    if (adminConnected) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`).catch(() => undefined);
      for (const role of [reader, writer, elevated]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  });

  const connectors: PostgresConnector[] = [];
  it('postgres_activation_refuses_effective_write_or_elevated_privileges', async () => {
    await admin.connect();
    adminConnected = true;
    await admin.query(`CREATE ROLE ${quoted(reader)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await admin.query(`CREATE ROLE ${quoted(writer)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await admin.query(`CREATE ROLE ${quoted(elevated)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER CREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await admin.query(`CREATE SCHEMA ${quoted(schema)}`);
    await admin.query(`CREATE TABLE ${quoted(schema)}.parent_rows (id integer PRIMARY KEY)`);
    await admin.query(`CREATE TABLE ${quoted(schema)}.source_rows (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES ${quoted(schema)}.parent_rows(id), label text NOT NULL)`);
    await admin.query(`INSERT INTO ${quoted(schema)}.parent_rows VALUES (1)`);
    await admin.query(`INSERT INTO ${quoted(schema)}.source_rows VALUES (1, 1, 'fictional')`);
    await admin.query(`GRANT CONNECT ON DATABASE ${quoted(process.env.SI_TEST_DATABASE ?? "si_test")} TO ${quoted(reader)}, ${quoted(writer)}, ${quoted(elevated)}`);
    await admin.query(`GRANT USAGE ON SCHEMA ${quoted(schema)} TO ${quoted(reader)}, ${quoted(writer)}, ${quoted(elevated)}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoted(schema)} TO ${quoted(reader)}, ${quoted(writer)}, ${quoted(elevated)}`);
    await admin.query(`GRANT INSERT ON ALL TABLES IN SCHEMA ${quoted(schema)} TO ${quoted(writer)}`);

    const readOnly = new PostgresConnector({ connectionString: urlFor(reader) });
    const writable = new PostgresConnector({ connectionString: urlFor(writer) });
    const roleElevated = new PostgresConnector({ connectionString: urlFor(elevated) });
    connectors.push(readOnly, writable, roleElevated);
    await expect(readOnly.test()).resolves.toMatchObject({ ok: true, readOnly: true });
    await expect(readOnly.structuralReferences()).resolves.toEqual([{ from: `${schema}.source_rows`, to: `${schema}.parent_rows`, fromColumn: 'parent_id', toColumn: 'id' }]);
    await expect(writable.test()).rejects.toThrow('postgres_connector_role_not_read_only');
    await expect(roleElevated.test()).rejects.toThrow('postgres_connector_role_not_read_only');
  });

  it('postgres_connector_sets_timeout_and_row_ceiling', async () => {
    // The catalog has its own ceiling, separate from the data-read row limit (decision 51).
    const limited = new PostgresConnector({ connectionString: urlFor(reader), maxRows: 1, maxCatalogRows: 1, statementTimeoutMs: 10_000 });
    connectors.push(limited);
    await expect(limited.discover({ mode: 'profile' })).rejects.toThrow('postgres_connector_result_limit_exceeded');
    const configured = new PostgresConnector({ connectionString: urlFor(reader), maxRows: 100, statementTimeoutMs: 75 });
    connectors.push(configured);
    await admin.query(`CREATE FUNCTION ${quoted(schema)}.slow_true() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN TRUE; END $$`);
    await admin.query(`CREATE VIEW ${quoted(schema)}.slow_view AS SELECT 1 AS id WHERE ${quoted(schema)}.slow_true()`);
    await admin.query(`GRANT SELECT ON ${quoted(schema)}.slow_view TO ${quoted(reader)}`);
    await expect(configured.test()).resolves.toMatchObject({ readOnly: true });
    const objects = await configured.discover({ mode: 'profile' });
    const slow = objects.objects.find((object) => object.qualifiedName === `${schema}.slow_view`);
    expect(slow).toBeDefined();
    await expect(configured.queryAggregate(slow!.assetKey, 'count')).rejects.toThrow(/statement timeout/i);
  });
});

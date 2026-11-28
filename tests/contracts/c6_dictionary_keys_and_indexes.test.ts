import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { buildServer } from '@scaleinsyght/api/server';
import { createTenant } from '../../scripts/tenant-create.js';

// The Dictionary's "Keys and indexes" card: primary key, unique constraints and indexes read from the source catalog,
// kept with the table's versioned structure. Generic fixture on real PostgreSQL.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') }); const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const schema = `keys_${randomUUID().replaceAll('-', '').slice(0, 10)}`; const mine = (name: string) => name.startsWith(`${schema}.`);
const tenantId = `keys-${randomUUID()}`; const email = `owner@${tenantId}.test.invalid`; const password = 'keys-password-1';
let server: Awaited<ReturnType<typeof buildServer>>; let cookie = ''; let connectionId = '';
function scoped(): ReadOnlyConnector {
  const real = createPostgresConnector({ connectionString: url('DATABASE_URL_MIGRATE'), statementTimeoutMs: 10_000 });
  return new Proxy(real, { get: (target, key) => {
    if (key === 'discover') return async (input: Parameters<ReadOnlyConnector['discover']>[0]) => { const found = await target.discover(input); const objects = found.objects.filter((object) => mine(object.qualifiedName));
      return { ...found, objects, unchangedObjects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: objects.length, accessible: objects.length, inaccessible: 0 } }; };
    if (key === 'keysAndIndexes') return async () => (await target.keysAndIndexes!()).filter((entry) => mine(entry.table));
    if (key === 'routines' || key === 'viewDefinitions' || key === 'objectOrigins') return async () => [];
    if (key === 'structuralReferences') return async () => [];
    const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value;
  } }) as ReadOnlyConnector;
}
const detail = async (name: string) => (await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/dictionary/object?name=${encodeURIComponent(name)}`, headers: { cookie } })).json();

describe('contract 6 keys and indexes', () => {
  beforeAll(async () => {
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    await migratePool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.orders(order_id integer, line_no integer, customer_id integer, ordered_on date, code text, PRIMARY KEY (order_id, line_no), CONSTRAINT uq_orders_code UNIQUE (code));
      CREATE INDEX ix_orders_customer_day ON ${schema}.orders(customer_id, ordered_on);
      CREATE INDEX ix_orders_lower_code ON ${schema}.orders(lower(code));
      CREATE TABLE ${schema}.notes(note text);`);
    const { userId } = await createTenant(migratePool, { tenantId, name: 'Keys', displayName: 'Keys Tester', email, password });
    connectionId = (await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' })).connectionId;
    const connector = scoped();
    try { await runProfile(appPool, { tenantId, connectionId, connector, jobType: 'discovery' }); } finally { await connector.close?.(); }
    server = await buildServer({ pool: appPool, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
  }, 120_000);
  afterAll(async () => { await server?.close(); await migratePool.query(`DROP SCHEMA ${schema} CASCADE`); await appPool.end(); await migratePool.end(); });

  it('c6_keys_and_indexes_are_read_from_the_catalog', async () => {
    const orders = await detail(`${schema}.orders`);
    expect(orders.indexes.primaryKey).toEqual(['order_id', 'line_no']);
    expect(orders.indexes.indexes).toEqual(expect.arrayContaining([
      { name: 'ix_orders_customer_day', columns: ['customer_id', 'ordered_on'], unique: false, primary: false },
      { name: 'ix_orders_lower_code', columns: ['(expression)'], unique: false, primary: false },
      { name: 'uq_orders_code', columns: ['code'], unique: true, primary: false },
    ]));
    expect(orders.indexes.indexes.filter((index: { primary: boolean }) => index.primary)).toHaveLength(1);
    // A table without any reads as such, not as "not read".
    expect((await detail(`${schema}.notes`)).indexes).toEqual({ primaryKey: [], indexes: [] });
  });
});

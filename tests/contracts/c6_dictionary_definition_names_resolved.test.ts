import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { buildServer } from '@scaleinsyght/api/server';
import { createTenant } from '../../scripts/tenant-create.js';

// A routine's Reads, Writes and Calls name only objects of the source's harvested catalog (found on a real source,
// where a function listed a CTE and a set-returning function as tables read). Generic fixture on real PostgreSQL.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') }); const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const schema = `names_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const mine = (name: string) => name.startsWith(`${schema}.`);
const tenantId = `names-${randomUUID()}`; const email = `owner@${tenantId}.test.invalid`; const password = 'names-password-1';
let server: Awaited<ReturnType<typeof buildServer>>; let cookie = ''; let connectionId = '';
function scoped(): ReadOnlyConnector {
  const real = createPostgresConnector({ connectionString: url('DATABASE_URL_MIGRATE'), statementTimeoutMs: 10_000 });
  return new Proxy(real, { get: (target, key) => {
    if (key === 'discover') return async (input: Parameters<ReadOnlyConnector['discover']>[0]) => { const found = await target.discover(input); const objects = found.objects.filter((object) => mine(object.qualifiedName));
      return { ...found, objects, unchangedObjects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: objects.length, accessible: objects.length, inaccessible: 0 } }; };
    if (key === 'routines') return async () => (await target.routines!()).filter((routine) => mine(routine.qualifiedName));
    if (key === 'objectOrigins') return async () => (await target.objectOrigins!()).filter((origin) => mine(origin.qualifiedName));
    if (key === 'viewDefinitions') return async () => (await target.viewDefinitions!()).filter((view) => mine(view.qualifiedName));
    if (key === 'structuralReferences') return async () => [];
    const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value;
  } }) as ReadOnlyConnector;
}
const get = async (path: string) => { const response = await server.inject({ method: 'GET', url: path, headers: { cookie } }); expect(response.statusCode, response.body).toBe(200); return response.json(); };
const detail = (name: string) => get(`/api/connections/${connectionId}/dictionary/object?name=${encodeURIComponent(name)}`);
const report = `${schema}.orders_by_customer(p_ids text, p_day date)`; const split = `${schema}.split_list(p_text text)`; const year = `${schema}.fiscal_year(p_day date)`;

describe('contract 6 definition names resolve against the catalog', () => {
  beforeAll(async () => {
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    await migratePool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.customers(customer_id integer PRIMARY KEY, name text);
      CREATE TABLE ${schema}.orders(order_id integer PRIMARY KEY, customer_id integer, ordered_on date);
      CREATE TABLE ${schema}.daily_totals(day date, n bigint);
      CREATE FUNCTION ${schema}.split_list(p_text text) RETURNS TABLE(item text) LANGUAGE sql AS $f$ SELECT unnest(string_to_array(p_text, ',')) $f$;
      CREATE FUNCTION ${schema}.fiscal_year(p_day date) RETURNS integer LANGUAGE sql AS $f$ SELECT extract(year FROM p_day)::int $f$;
      CREATE FUNCTION ${schema}.orders_by_customer(p_ids text, p_day date) RETURNS TABLE(customer_name text, order_count bigint) LANGUAGE plpgsql AS $f$
      DECLARE rec record;
      BEGIN
        CREATE TEMP TABLE tmp_ids AS SELECT item::int AS id FROM ${schema}.split_list(p_ids) AS item;
        FOR rec IN SELECT o.order_id FROM ${schema}.orders o LOOP NULL; END LOOP;
        INSERT INTO ${schema}.daily_totals SELECT p_day, count(*) FROM ${schema}.orders;
        RETURN QUERY WITH picked AS (SELECT c.customer_id, c.name FROM ${schema}.customers c JOIN tmp_ids t ON t.id = c.customer_id)
          SELECT p.name, count(*) FROM picked p JOIN ${schema}.orders o ON o.customer_id = p.customer_id
          WHERE ${schema}.fiscal_year(o.ordered_on) = ${schema}.fiscal_year(p_day) GROUP BY p.name;
      END $f$;`);
    const { userId } = await createTenant(migratePool, { tenantId, name: 'Names', displayName: 'Names Tester', email, password });
    connectionId = (await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' })).connectionId;
    const connector = scoped();
    try { await runProfile(appPool, { tenantId, connectionId, connector, jobType: 'discovery' }); } finally { await connector.close?.(); }
    server = await buildServer({ pool: appPool, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
  }, 120_000);
  afterAll(async () => { await server?.close(); await migratePool.query(`DROP SCHEMA ${schema} CASCADE`); await appPool.end(); await migratePool.end(); });

  it('c6_definition_reads_writes_and_calls_name_only_catalog_objects', async () => {
    const opened = await detail(report);
    expect(opened.definition.reads).toEqual([`${schema}.customers`, `${schema}.orders`]);
    expect(opened.definition.writes).toEqual([{ table: `${schema}.daily_totals`, mode: 'insert' }]);
    expect(opened.definition.calls).toEqual([year, split].sort());
    expect(opened.definition.unresolved).toEqual([]);
    // The Tables and columns tab and the drafted description use the same resolved lists.
    expect(opened.definition.tablesAndColumns.map((item: { table: string }) => item.table).sort()).toEqual([`${schema}.customers`, `${schema}.daily_totals`, `${schema}.orders`]);
    expect(opened.description.text).toBe(`Routine that inserts into ${schema}.daily_totals, reading ${schema}.customers and ${schema}.orders. It runs ${schema}.fiscal_year and ${schema}.split_list.`);
  });

  it('c6_a_called_routine_lists_its_caller_and_opens_from_the_call', async () => {
    for (const callee of [split, year]) expect((await detail(callee)).definition.calledBy, callee).toEqual([report]);
    // The orders table counts this function once as a reader, never the CTE or the set-returning function.
    const orders = await detail(`${schema}.orders`);
    expect(orders.usedBy.filter((item: { how: string }) => item.how === 'reads').map((item: { name: string }) => item.name)).toEqual([report]);
  });
});

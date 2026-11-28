import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { draftModelDescriptions, runProfile, type DescribeRequest } from '@scaleinsyght/profiler';
import { buildServer } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';
import { createTenant } from '../../scripts/tenant-create.js';

// Decision 66 with contract 7: model-drafted descriptions see metadata only. Distinctive values planted in the data
// never reach a request; imported descriptions win; drafts are "Drafted" until approved; unchanged input is not
// redrafted; a budget failure or an invalid draft keeps the code template. The model is a stub; no network.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') }); const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const schema = `drafts_${randomUUID().replaceAll('-', '').slice(0, 10)}`; const mine = (name: string) => name.startsWith(`${schema}.`);
const planted = ['ZQX-PLANTED-4471', 'planted.person@example.test', '+44 7700 900461'];
const tenantId = `drafts-${randomUUID()}`; const email = `owner@${tenantId}.test.invalid`; const password = 'drafts-password-1';
let server: Awaited<ReturnType<typeof buildServer>>; let cookie = ''; let connectionId = '';
function scoped(): ReadOnlyConnector {
  const real = createPostgresConnector({ connectionString: url('DATABASE_URL_MIGRATE'), statementTimeoutMs: 10_000 });
  return new Proxy(real, { get: (target, key) => {
    if (key === 'discover') return async (input: Parameters<ReadOnlyConnector['discover']>[0]) => { const found = await target.discover(input); const objects = found.objects.filter((object) => mine(object.qualifiedName));
      return { ...found, objects, unchangedObjects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: objects.length, accessible: objects.length, inaccessible: 0 } }; };
    if (key === 'routines') return async () => (await target.routines!()).filter((routine) => mine(routine.qualifiedName));
    if (key === 'objectOrigins') return async () => (await target.objectOrigins!()).filter((origin) => mine(origin.qualifiedName));
    if (key === 'viewDefinitions') return async () => (await target.viewDefinitions!()).filter((view) => mine(view.qualifiedName));
    if (key === 'structuralReferences') return async (scope: Parameters<NonNullable<ReadOnlyConnector['structuralReferences']>>[0]) => (await target.structuralReferences!(scope)).filter((item) => mine(item.from));
    const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value;
  } }) as ReadOnlyConnector;
}
const requests: DescribeRequest[] = [];
const writer = (text: (name: string) => string) => async (request: DescribeRequest) => { requests.push(request); const names = (request.responseSchema as { properties: { descriptions: { items: { properties: { name: { enum: string[] } } } } } }).properties.descriptions.items.properties.name.enum;
  return { text: JSON.stringify({ descriptions: names.map((name) => ({ name, text: text(name) })) }) }; };
const plain = (name: string) => `Keeps the ${name.split('.').at(-1)!.replace(/[_(].*$/, '')} records for day-to-day work.`;
const detail = async (name: string) => (await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/dictionary/object?name=${encodeURIComponent(name)}`, headers: { cookie } })).json();
const draft = (complete: Parameters<typeof draftModelDescriptions>[1]['complete']) => draftModelDescriptions(appPool, { tenantId, connectionId, complete });

describe('contract 7 model-drafted descriptions', () => {
  beforeAll(async () => {
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    await migratePool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.customers(customer_id integer PRIMARY KEY, name text, email text, phone text);
      CREATE TABLE ${schema}.orders(order_id integer PRIMARY KEY, customer_id integer REFERENCES ${schema}.customers(customer_id), code text);
      CREATE TABLE ${schema}.regions(region_id integer PRIMARY KEY, label text);
      INSERT INTO ${schema}.customers SELECT g, '${planted[0]}', '${planted[1]}', '${planted[2]}' FROM generate_series(1, 30) g;
      INSERT INTO ${schema}.orders SELECT g, 1 + g % 30, '${planted[0]}' FROM generate_series(1, 60) g;
      CREATE FUNCTION ${schema}.order_count(p_customer integer) RETURNS bigint LANGUAGE sql AS $f$ SELECT count(*) FROM ${schema}.orders WHERE customer_id = p_customer AND code <> '${planted[0]}' $f$;`);
    const { userId } = await createTenant(migratePool, { tenantId, name: 'Drafts', displayName: 'Drafts Tester', email, password });
    connectionId = (await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' })).connectionId;
    const connector = scoped();
    try { await runProfile(appPool, { tenantId, connectionId, connector, jobType: 'discovery' }); } finally { await connector.close?.(); }
    server = await buildServer({ pool: appPool, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
    // An imported description for regions: it wins, so regions is never drafted.
    await withTenant(migratePool, tenantId, (db) => db.query(`INSERT INTO graph.dictionary_descriptions(tenant_id,source_id,table_name,column_name,description,origin) VALUES($1,$2,$3,'',$4,'imported')`,
      [tenantId, connectionId, `${schema}.regions`, 'One row per sales region.']));
  }, 120_000);
  afterAll(async () => { await server?.close(); await migratePool.query(`DROP SCHEMA ${schema} CASCADE`); await appPool.end(); await migratePool.end(); });

  it('c7_model_drafts_see_metadata_only_and_show_as_drafted', async () => {
    const result = await draft(writer(plain));
    expect(result).toMatchObject({ drafted: 3, kept: 0, stopped: null });
    const sent = JSON.stringify(requests);
    for (const value of planted) expect(sent).not.toContain(value);
    expect(sent).not.toMatch(/distinct|null_rate|row_count|"rows"/i);
    expect(sent).not.toContain(`${schema}.regions`);
    expect(sent).toContain(`${schema}.customers`); expect(sent).toContain('order_count');
    expect((await detail(`${schema}.customers`)).description).toEqual({ text: 'Keeps the customers records for day-to-day work.', origin: 'drafted' });
    expect((await detail(`${schema}.regions`)).description).toMatchObject({ text: 'One row per sales region.', origin: 'imported' });
    // Approving records the exact model text and keeps it marked as model-drafted.
    const approved = await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/dictionary/description`, headers: { cookie }, payload: { name: `${schema}.orders`, action: 'approve' } });
    expect(approved.json()).toMatchObject({ status: 'approved', text: 'Keeps the orders records for day-to-day work.' });
    const stored = await withTenant(migratePool, tenantId, (db) => db.query<{ drafted_by: string }>("SELECT drafted_by FROM graph.description_reviews WHERE tenant_id=$1 AND qualified_name=$2", [tenantId, `${schema}.orders`]));
    expect(stored.rows[0]!.drafted_by).toBe('model');
  });

  it('c7_unchanged_input_is_not_redrafted_and_a_failure_keeps_the_template', async () => {
    requests.length = 0;
    expect(await draft(writer(plain))).toMatchObject({ pending: 0, calls: 0, drafted: 0 });
    // The customers table changes; the model is out of budget: no further calls, and the outdated draft gives way to the template.
    await migratePool.query(`ALTER TABLE ${schema}.customers ADD COLUMN segment text`);
    const connector = scoped();
    try { await runProfile(appPool, { tenantId, connectionId, connector, jobType: 'discovery' }); } finally { await connector.close?.(); }
    let calls = 0;
    const result = await draft(async () => { calls++; throw Object.assign(new Error('model_budget_daily_cap_reached'), { code: 'model_budget_daily_cap_reached' }); });
    expect(result).toMatchObject({ stopped: 'model_budget_daily_cap_reached', drafted: 0 });
    expect(calls).toBe(1);
    const customers = await detail(`${schema}.customers`);
    expect(customers.description.origin).toBe('drafted');
    expect(customers.description.text).toMatch(/^Table customers with 5 columns/);
    // An invalid draft (not a sentence) also keeps the template.
    expect(await draft(writer(() => 'customer stuff'))).toMatchObject({ drafted: 0, kept: 1 });
    expect((await detail(`${schema}.customers`)).description.text).toMatch(/^Table customers with 5 columns/);
  });
});

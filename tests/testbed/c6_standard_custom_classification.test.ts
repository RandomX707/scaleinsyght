import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';

// Decision 62 (test_emr: everything showed as Standard): Standard means vendor-delivered and Custom customer-built.
// Without a vendor dictionary nothing is Standard by default; Controls rules (name prefix, schema, owner) and copy
// detection mark Custom; an imported vendor dictionary decides for the tables it lists.
config({ path: resolve('.env') });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required`); const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString(); };
const appPool = new Pool({ connectionString: url('DATABASE_URL') }); const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const tag = randomUUID().replaceAll('-', '').slice(0, 10); const main = `vendor_${tag}`; const local = `local_${tag}`;
const tenantId = `classify-${randomUUID()}`; const email = `${tenantId}@synthetic.example`; const password = 'classification-password';
let server: Awaited<ReturnType<typeof buildServer>>; let cookie = ''; let connectionId = ''; let owner = '';

/** The real connector, seeing only this test's two schemas. */
function scoped(): ReadOnlyConnector {
  const real = createPostgresConnector({ connectionString: url('DATABASE_URL_MIGRATE'), statementTimeoutMs: 10_000 });
  const mine = (name: string) => name.startsWith(`${main}.`) || name.startsWith(`${local}.`);
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
type Listed = { tab: string; counts: Record<string, number>; groups: Array<{ label: string; items: Array<{ name: string; copyOf?: string; copySimilarity?: number; originReason?: string }> }> };
const list = async (tab?: string) => (await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/dictionary/objects${tab ? `?tab=${tab}` : ''}`, headers: { cookie } })).json<Listed>();
const names = (listed: Listed) => listed.groups.flatMap((group) => group.items.map((item) => item.name)).sort();
const reasons = (listed: Listed) => Object.fromEntries(listed.groups.flatMap((group) => group.items.map((item) => [item.name, item.originReason ?? null])));
async function rules(classification: { customPrefixes: string[]; customSchemas: string[]; ownerPatterns: string[] }) {
  await withTenant(migratePool, tenantId, (db) => db.query(`INSERT INTO registry.connection_controls(tenant_id,connection_id,policy,known_objects,revision) VALUES($1,$2,$3::jsonb,'{}',1)
    ON CONFLICT (tenant_id,connection_id) DO UPDATE SET policy=EXCLUDED.policy,revision=registry.connection_controls.revision+1`,
    [tenantId, connectionId, JSON.stringify({ groups: {}, nameRules: [], columnRules: [], newObjects: 'approve', leavingScope: 'keep', approval: true, classification })]));
}

describe('decision 62 Standard and Custom', () => {
  beforeAll(async () => {
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    await migratePool.query(`CREATE SCHEMA ${main}; CREATE SCHEMA ${local};
      CREATE TABLE ${main}.encounters(encounter_id integer PRIMARY KEY, kind text, admitted_at date, ward text, patient_ref integer);
      CREATE TABLE ${main}."X_READMITS"(encounter_id integer);
      CREATE TABLE ${main}.admissions(patient_ref integer, admitted_at date, ward text);
      CREATE TABLE ${local}.extract(id integer);
      CREATE PROCEDURE ${main}.usp_load_admissions() LANGUAGE plpgsql AS $procedure$
      BEGIN
        INSERT INTO ${main}.admissions (patient_ref, admitted_at, ward) SELECT e.patient_ref, e.admitted_at, e.ward FROM ${main}.encounters e WHERE e.kind = 'inpatient' AND e.admitted_at >= DATE '2024-01-01';
        DELETE FROM ${main}.admissions WHERE admitted_at < DATE '2020-01-01';
      END $procedure$;`);
    // A customer's copy of the vendor procedure, made later and as a function.
    await migratePool.query(`CREATE FUNCTION ${main}.fn_load_admissions_copy() RETURNS void LANGUAGE plpgsql AS $function$
      BEGIN -- copied from the vendor procedure
        INSERT INTO ${main}.admissions (patient_ref, admitted_at, ward) SELECT e.patient_ref, e.admitted_at, e.ward FROM ${main}.encounters e WHERE e.kind = 'inpatient' AND e.admitted_at >= DATE '2024-01-01';
        DELETE FROM ${main}.admissions WHERE admitted_at < DATE '2020-01-01';
      END $function$;`);
    owner = (await migratePool.query<{ owner: string }>('SELECT current_user AS owner')).rows[0]!.owner;
    const userId = await withTenant(migratePool, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      return (await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id', [tenantId, email, hashPassword(password)])).rows[0]!.user_id;
    });
    connectionId = (await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' })).connectionId;
    const connector = scoped();
    try { await runProfile(appPool, { tenantId, connectionId, connector, jobType: 'discovery' }); } finally { await connector.close?.(); }
    server = await buildServer({ pool: appPool, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
  }, 120_000);
  afterAll(async () => { await server?.close(); await migratePool.query(`DROP SCHEMA ${main} CASCADE; DROP SCHEMA ${local} CASCADE`); await appPool.end(); await migratePool.end(); });

  it('c6_without_a_vendor_dictionary_nothing_is_standard_and_the_page_opens_on_not_classified', async () => {
    const first = await list();
    expect(first.tab).toBe('unclassified');
    expect(first.counts.standard).toBe(0);
    expect(names(first)).toEqual([`${main}.admissions`, `${main}.encounters`, `${local}.extract`, `${main}.usp_load_admissions()`].sort());
    expect(first.groups.map((group) => group.label)).toEqual(expect.arrayContaining(['Tables', 'Procedures']));
  });

  it('c6_the_default_name_prefix_and_copy_detection_mark_custom', async () => {
    const custom = await list('custom');
    expect(reasons(custom)).toEqual({ [`${main}.X_READMITS`]: 'name_prefix', [`${main}.fn_load_admissions_copy()`]: 'copy' });
    const copy = custom.groups.flatMap((group) => group.items).find((item) => item.name === `${main}.fn_load_admissions_copy()`)!;
    expect(copy.copyOf).toBe(`${main}.usp_load_admissions()`);
    expect(copy.copySimilarity).toBeGreaterThanOrEqual(0.9);
  });

  it('c6_custom_schema_and_owner_rules_from_controls_mark_custom', async () => {
    await rules({ customPrefixes: ['X_'], customSchemas: [local], ownerPatterns: [] });
    expect(reasons(await list('custom'))[`${local}.extract`]).toBe('schema');
    await rules({ customPrefixes: ['X_'], customSchemas: [], ownerPatterns: ['nobody_*'] });
    expect(names(await list('custom'))).not.toContain(`${main}.encounters`);
    await rules({ customPrefixes: ['X_'], customSchemas: [], ownerPatterns: [`${owner.slice(0, 3)}*`] });
    expect(reasons(await list('custom'))[`${main}.encounters`]).toBe('owner');
    await rules({ customPrefixes: ['X_'], customSchemas: [], ownerPatterns: [] });
  });

  it('c6_an_imported_vendor_dictionary_makes_listed_tables_standard_and_the_rest_custom', async () => {
    const csv = `table,column,description\n${main}.encounters,encounter_id,Encounter key\n${main}.admissions,ward,Ward\n`;
    const imported = await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/dictionary/import`, headers: { cookie }, payload: { format: 'csv', filename: 'vendor.csv', contentBase64: Buffer.from(csv).toString('base64') } });
    expect(imported.statusCode, imported.body).toBeLessThan(300);
    const standard = await list('standard');
    expect(names(standard)).toEqual([`${main}.admissions`, `${main}.encounters`]);
    expect(reasons(await list('custom'))[`${local}.extract`]).toBe('not_in_vendor_dictionary');
    // The dictionary lists tables, so routines are still decided by rules and copy detection.
    expect(names(await list('unclassified'))).toEqual([`${main}.usp_load_admissions()`]);
  });
});

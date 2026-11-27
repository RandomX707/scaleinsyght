import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { buildServer } from '@scaleinsyght/api/server';
import { createTenant } from '../../scripts/tenant-create.js';
import JSZip from 'jszip';

// Decision 64 (overrides decision 62): Standard and Custom are decided by object type from the catalog, for every
// source, automatically. Standard is base tables; Custom is views, materialized views, procedures, functions and
// packages. No rules, scoring, vendor-dictionary comparison or per-object approval. Copy detection is an informational
// badge only. Drafted descriptions are shown and used as "Drafted"; Approve all is optional and takes one request.
// Found on test_emr: a function with 3 inputs showed "Parameters 16" because its RETURNS TABLE columns were listed
// as inputs.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') }); const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const schema = `bytype_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const mine = (name: string) => name.startsWith(`${schema}.`);
const tenantId = `bytype-${randomUUID()}`; const email = `owner@${tenantId}.test.invalid`; const password = 'by-type-password-1';
let server: Awaited<ReturnType<typeof buildServer>>; let cookie = ''; let connectionId = '';

/** The real connector, seeing only this test's schema. */
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
type Listed = { tab: string; counts: Record<string, number>; drafted: number; groups: Array<{ label: string; items: Array<{ name: string; copyOf?: string; copySimilarity?: number }> }> };
const inject = async (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) => server.inject({ method, url: path, headers: { cookie }, ...(payload ? { payload } : {}) });
const get = async (path: string) => { const response = await inject('GET', path); expect(response.statusCode, response.body).toBe(200); return response.json(); };
const list = async (query = '') => (await get(`/api/connections/${connectionId}/dictionary/objects${query}`)) as Listed;
const names = (listed: Listed) => listed.groups.flatMap((group) => group.items.map((item) => item.name)).sort();
const detail = (name: string) => get(`/api/connections/${connectionId}/dictionary/object?name=${encodeURIComponent(name)}`);
const tables = [`${schema}.X_READMITS`, `${schema}.admissions`, `${schema}.encounters`];
const routines = [`${schema}.e02_a1c(p_patient integer, p_from date, p_to date)`, `${schema}.fn_load_admissions_copy()`, `${schema}.fn_ward_totals(p_ward text, OUT admitted bigint, OUT discharged bigint)`,
  `${schema}.usp_count_admissions(IN p_ward text, OUT p_count bigint)`, `${schema}.usp_load_admissions()`];

describe('decision 64 Standard and Custom by object type', () => {
  beforeAll(async () => {
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    await migratePool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.encounters(encounter_id integer PRIMARY KEY, kind text, admitted_at date, ward text, patient_ref integer);
      CREATE TABLE ${schema}."X_READMITS"(encounter_id integer REFERENCES ${schema}.encounters(encounter_id));
      CREATE TABLE ${schema}.admissions(patient_ref integer, admitted_at date, ward text);
      CREATE VIEW ${schema}.v_ward_census AS SELECT ward, count(*) AS stays FROM ${schema}.encounters GROUP BY ward;
      CREATE PROCEDURE ${schema}.usp_load_admissions() LANGUAGE plpgsql AS $procedure$
      BEGIN
        INSERT INTO ${schema}.admissions (patient_ref, admitted_at, ward) SELECT e.patient_ref, e.admitted_at, e.ward FROM ${schema}.encounters e WHERE e.kind = 'inpatient' AND e.admitted_at >= DATE '2024-01-01';
        DELETE FROM ${schema}.admissions WHERE admitted_at < DATE '2020-01-01';
      END $procedure$;
      CREATE PROCEDURE ${schema}.usp_count_admissions(IN p_ward text, OUT p_count bigint) LANGUAGE plpgsql AS $procedure$
      BEGIN SELECT count(*) INTO p_count FROM ${schema}.admissions WHERE ward = p_ward; END $procedure$;
      CREATE FUNCTION ${schema}.fn_ward_totals(p_ward text, OUT admitted bigint, OUT discharged bigint) LANGUAGE sql AS $function$
        SELECT count(*), count(*) FILTER (WHERE kind = 'discharged') FROM ${schema}.encounters WHERE ward = p_ward $function$;
      CREATE FUNCTION ${schema}.e02_a1c(p_patient integer, p_from date, p_to date)
        RETURNS TABLE(c01 integer, c02 text, c03 date, c04 date, c05 text, c06 integer, c07 numeric, c08 numeric, c09 text, c10 text, c11 boolean, c12 date, c13 integer)
        LANGUAGE sql AS $function$ SELECT encounter_id, kind, admitted_at, admitted_at, ward, patient_ref, 0::numeric, 0::numeric, '', '', true, admitted_at, 1
          FROM ${schema}.encounters WHERE patient_ref = p_patient AND admitted_at BETWEEN p_from AND p_to $function$;`);
    // A customer's copy of the procedure, made later and as a function.
    await migratePool.query(`CREATE FUNCTION ${schema}.fn_load_admissions_copy() RETURNS void LANGUAGE plpgsql AS $function$
      BEGIN -- copied from the procedure
        INSERT INTO ${schema}.admissions (patient_ref, admitted_at, ward) SELECT e.patient_ref, e.admitted_at, e.ward FROM ${schema}.encounters e WHERE e.kind = 'inpatient' AND e.admitted_at >= DATE '2024-01-01';
        DELETE FROM ${schema}.admissions WHERE admitted_at < DATE '2020-01-01';
      END $function$;`);
    const { userId } = await createTenant(migratePool, { tenantId, name: 'By type', displayName: 'Type Tester', email, password });
    connectionId = (await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' })).connectionId;
    const connector = scoped();
    try { await runProfile(appPool, { tenantId, connectionId, connector, jobType: 'discovery' }); } finally { await connector.close?.(); }
    server = await buildServer({ pool: appPool, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
  }, 120_000);
  afterAll(async () => { await server?.close(); await migratePool.query(`DROP SCHEMA ${schema} CASCADE`); await appPool.end(); await migratePool.end(); });

  it('c6_standard_is_base_tables_and_custom_is_what_is_built_over_them', async () => {
    const first = await list();
    expect(first.tab).toBe('standard');
    expect(first.counts).toEqual({ standard: 3, custom: 1 + routines.length });
    expect(names(first)).toEqual(tables);
    expect(first.groups.map((group) => group.label)).toEqual(['Tables']);
    const custom = await list('?tab=custom');
    expect(names(custom)).toEqual([`${schema}.v_ward_census`, ...routines].sort());
    expect(custom.groups.map((group) => group.label)).toEqual(expect.arrayContaining(['Views', 'Functions']));
    expect(custom.groups.filter((group) => group.label.startsWith('Procedures · ')).flatMap((group) => group.items.map((item) => item.name)).sort()).toEqual(routines.filter((name) => name.includes('.usp_')));
    // A customer-named table is still a table, so Standard; there is no third tab.
    expect((await detail(`${schema}.X_READMITS`)).origin).toBe('standard');
    expect((await inject('GET', `/api/connections/${connectionId}/dictionary/objects?tab=unclassified`)).json().tab).toBe('standard');
  });

  it('c6_a_copy_is_an_informational_badge_and_never_changes_the_tab', async () => {
    const items = (await list('?tab=custom')).groups.flatMap((group) => group.items);
    const copy = items.find((item) => item.name === `${schema}.fn_load_admissions_copy()`)!;
    expect(copy.copyOf).toBe(`${schema}.usp_load_admissions()`);
    expect(copy.copySimilarity).toBeGreaterThanOrEqual(0.9);
    expect(items.filter((item) => item.copyOf).map((item) => item.name)).toEqual([copy.name]);
    const opened = await detail(copy.name);
    expect(opened).toMatchObject({ origin: 'custom', copyOf: `${schema}.usp_load_admissions()` });
    expect(opened).not.toHaveProperty('originReason');
  });

  it('c6_function_inputs_are_kept_apart_from_returned_columns', async () => {
    const a1c = await detail(`${schema}.e02_a1c(p_patient integer, p_from date, p_to date)`);
    expect(a1c.definition.parameters.map((parameter: { name: string; mode: string }) => [parameter.name, parameter.mode])).toEqual([['p_patient', 'in'], ['p_from', 'in'], ['p_to', 'in']]);
    expect(a1c.definition.returns.map((column: { name: string }) => column.name)).toEqual(Array.from({ length: 13 }, (_, index) => `c${String(index + 1).padStart(2, '0')}`));
    expect(a1c.definition.returns[0]).toEqual({ name: 'c01', dataType: 'integer' });
    // A function's OUT arguments are what it returns; a procedure's OUT argument is an output parameter.
    const totals = await detail(`${schema}.fn_ward_totals(p_ward text, OUT admitted bigint, OUT discharged bigint)`);
    expect(totals.definition.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(['p_ward']);
    expect(totals.definition.returns.map((column: { name: string }) => column.name)).toEqual(['admitted', 'discharged']);
    const count = await detail(`${schema}.usp_count_admissions(IN p_ward text, OUT p_count bigint)`);
    expect(count.definition.parameters.map((parameter: { name: string; mode: string }) => [parameter.name, parameter.mode])).toEqual([['p_ward', 'in'], ['p_count', 'out']]);
    expect(count.definition.returns).toEqual([]);
  });

  it('c6_an_imported_vendor_dictionary_never_changes_standard_or_custom', async () => {
    const csv = `table,column,description\n${schema}.encounters,encounter_id,Encounter key\n`;
    const imported = await inject('POST', `/api/connections/${connectionId}/dictionary/import`, { format: 'csv', filename: 'vendor.csv', contentBase64: Buffer.from(csv).toString('base64') });
    expect(imported.statusCode, imported.body).toBeLessThan(300);
    expect(names(await list('?tab=standard'))).toEqual(tables);
    const summary = await get(`/api/connections/${connectionId}/dictionary/summary`);
    expect(summary.counts).toMatchObject({ standard: 3, custom: 1 + routines.length, tablesNotInDictionary: 2 });
    expect(summary.counts).not.toHaveProperty('unclassified');
  });

  it('c6_classification_rules_saved_before_decision_64_are_ignored_and_controls_still_save', async () => {
    await withTenant(migratePool, tenantId, (db) => db.query(`INSERT INTO registry.connection_controls(tenant_id,connection_id,policy,known_objects,revision) VALUES($1,$2,$3::jsonb,'{}',1)
      ON CONFLICT (tenant_id,connection_id) DO UPDATE SET policy=EXCLUDED.policy,revision=registry.connection_controls.revision+1`,
      [tenantId, connectionId, JSON.stringify({ groups: {}, nameRules: [], columnRules: [], newObjects: 'approve', leavingScope: 'keep', approval: false, classification: { customPrefixes: ['X_'], customSchemas: [schema], ownerPatterns: ['*'] } })]));
    expect(names(await list('?tab=standard'))).toEqual(tables);
    const controls = (await get(`/api/connections/${connectionId}/controls`)) as { revision: number; policy: Record<string, unknown>; overrides: unknown[] };
    expect(controls.policy).not.toHaveProperty('classification');
    const saved = await inject('PUT', `/api/connections/${connectionId}/controls`, { revision: controls.revision, policy: controls.policy, overrides: controls.overrides });
    expect(saved.statusCode, saved.body).toBe(200);
    const withRules = await inject('PUT', `/api/connections/${connectionId}/controls`, { revision: controls.revision + 1, policy: { ...controls.policy, classification: { customPrefixes: [], customSchemas: [], ownerPatterns: [] } }, overrides: controls.overrides });
    // A page still sending the old rules is accepted with them removed (the schema drops unknown properties).
    expect(withRules.statusCode, withRules.body).toBe(200);
    const stored = await withTenant(migratePool, tenantId, (db) => db.query<{ policy: Record<string, unknown> }>('SELECT policy FROM registry.connection_controls WHERE tenant_id=$1 AND connection_id=$2', [tenantId, connectionId]));
    expect(stored.rows[0]!.policy).not.toHaveProperty('classification');
  });

  it('c6_drafted_descriptions_are_shown_used_and_exported_without_approval', async () => {
    const summary = await get(`/api/connections/${connectionId}/dictionary/summary`);
    // encounters has an imported column description only, so its table-level description is still drafted.
    expect(summary.drafted).toBe(3 + 1 + routines.length);
    expect(summary.coverage.tables).toEqual({ documented: 4, drafted: 4, total: 4 }); // the view is a dataset too
    const readmits = await detail(`${schema}.X_READMITS`);
    expect(readmits.description).toEqual({ text: `Table X_READMITS with 1 column, linked by declared keys to ${schema}.encounters.`, origin: 'drafted' });
    expect((await detail(`${schema}.usp_load_admissions()`)).description).toMatchObject({ origin: 'drafted', text: expect.stringMatching(new RegExp(`^Procedure that .*${schema}\\.admissions.*reading ${schema}\\.encounters`)) });
    // Opening an object stores nothing: drafts are computed, and only approvals and edits are recorded.
    const stored = await withTenant(migratePool, tenantId, (db) => db.query('SELECT 1 FROM graph.description_reviews WHERE tenant_id=$1', [tenantId]));
    expect(stored.rowCount).toBe(0);
    const html = await inject('POST', '/api/dictionary/export-html', { acknowledged: true, connectionIds: [connectionId] });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('linked by declared keys to');
    expect(html.body).toContain('"descriptionState":"drafted"');
    // Markdown and Word carry the same descriptions, drafted ones marked (tables and views; routines are not in them).
    const markdown = await inject('GET', `/api/connections/${connectionId}/dictionary/export?format=markdown`);
    expect(markdown.body).toContain(`## ${schema}.X_READMITS\n\n**Drafted:** Table X_READMITS with 1 column, linked by declared keys to ${schema}.encounters.`);
    expect(markdown.body).toContain('| Encounter key |');
    const word = await inject('GET', `/api/connections/${connectionId}/dictionary/export?format=docx`);
    const document = await (await JSZip.loadAsync(word.rawPayload)).file('word/document.xml')!.async('string');
    expect(document).toContain('Drafted: Table X_READMITS with 1 column');
  });

  it('c6_approve_all_approves_a_filter_a_tab_or_a_source_in_one_request', async () => {
    const shown = (await detail(`${schema}.admissions`)).description.text as string;
    const filtered = await inject('POST', `/api/connections/${connectionId}/dictionary/descriptions/approve-all`, { tab: 'standard', q: 'admis' });
    expect(filtered.json()).toEqual({ approved: 1 });
    expect((await detail(`${schema}.admissions`)).description).toMatchObject({ text: shown, origin: 'approved', by: 'Type Tester' });
    expect((await list('?tab=standard')).drafted).toBe(2);
    expect((await list('?tab=custom')).drafted).toBe(1 + routines.length);
    // The list says what the rest are, so 3 Standard tables read "2 drafted, 1 approved", never just "2 drafted".
    expect((await list('?tab=standard') as unknown as { descriptions: object }).descriptions).toEqual({ drafted: 2, approved: 1, edited: 0, imported: 0 });
    // One object edited without opening it first, then the Custom tab, then the rest of the source.
    const edited = await inject('POST', `/api/connections/${connectionId}/dictionary/description`, { name: `${schema}.v_ward_census`, action: 'edit', text: 'Stays per ward.' });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await inject('POST', `/api/connections/${connectionId}/dictionary/descriptions/approve-all`, { tab: 'custom' })).json()).toEqual({ approved: routines.length });
    expect((await detail(`${schema}.v_ward_census`)).description).toMatchObject({ text: 'Stays per ward.', origin: 'edited' });
    expect((await list('?tab=custom') as unknown as { descriptions: object }).descriptions).toEqual({ drafted: 0, approved: routines.length, edited: 1, imported: 0 });
    // An edited description exports as it is, unmarked.
    expect((await inject('GET', `/api/connections/${connectionId}/dictionary/export?format=markdown`)).body).toContain(`## ${schema}.v_ward_census\n\nStays per ward.\n`);
    expect((await inject('POST', `/api/connections/${connectionId}/dictionary/descriptions/approve-all`, {})).json()).toEqual({ approved: 2 });
    const after = await get(`/api/connections/${connectionId}/dictionary/summary`);
    expect(after.drafted).toBe(0); expect(after.coverage.tables).toEqual({ documented: 4, drafted: 0, total: 4 });
    expect((await inject('POST', `/api/connections/${connectionId}/dictionary/descriptions/approve-all`, { tab: 'nonsense' })).statusCode).toBe(400);
    const decided = await withTenant(migratePool, tenantId, (db) => db.query<{ n: number }>("SELECT count(*)::int AS n FROM graph.description_reviews WHERE tenant_id=$1 AND decided_by IS NOT NULL AND decided_at IS NOT NULL", [tenantId]));
    expect(decided.rows[0]!.n).toBe(3 + 1 + routines.length);
  });
});

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildServer } from '@scaleinsyght/api/server';
import { createSqlServerConnector } from '@scaleinsyght/connectors';
import { withTenant } from '@scaleinsyght/db';
import { runProfile } from '@scaleinsyght/profiler';
import { activateConnection } from '@scaleinsyght/registry';
import { createTenant } from '../../scripts/tenant-create.js';

// The Dictionary against the real SQL Server Dictionary testbed (pnpm testbed:dictionary), compared with
// testbed/dictionary/truth.json. Decision 53: stored definitions are scrubbed; "Show original" is live and unstored.
config({ path: '.env' });
if (!process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('SQLSERVER_TESTBED_PASSWORD is required; run pnpm testbed:sqlserver:up and pnpm testbed:dictionary. Never skipped.');
const truth = JSON.parse(readFileSync('testbed/dictionary/truth.json', 'utf8')).sqlserver as {
  standardTables: string[]; customTables: string[]; customViews: string[]; foreignKeys: string[][]; hardCodedLiterals: string[]; sqlSearch: { query: string; object: string };
  procedures: Record<string, { group: string; writes: Array<{ table: string; mode: string }>; reads: string[]; calls: string[]; parameters: string[]; encrypted: boolean; calledBy?: string[] }>;
};
const url = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`${key} is required`); const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString(); };
const app = new Pool({ connectionString: url('DATABASE_URL') }); const migrate = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const connector = createSqlServerConnector({ server: process.env.SQLSERVER_TESTBED_HOST ?? 'localhost', port: Number(process.env.SQLSERVER_TESTBED_PORT ?? 1433), database: 'si_testbed_dictionary',
  username: process.env.SQLSERVER_TESTBED_USERNAME ?? 'si_testbed_reader', password: process.env.SQLSERVER_TESTBED_PASSWORD, encrypt: true, trustServerCertificate: true });
const tenantId = `dictionary-${randomUUID()}`; const password = 'dictionary-testbed-password-2026';
let server: Awaited<ReturnType<typeof buildServer>>; let cookie = ''; let connectionId = '';
const get = async (path: string) => { const response = await server.inject({ method: 'GET', url: path, headers: { cookie } }); expect(response.statusCode, response.body).toBe(200); return response.json(); };

describe('Dictionary on the SQL Server testbed', () => {
  beforeAll(async () => {
    const { userId } = await createTenant(migrate, { tenantId, name: 'Dictionary', displayName: 'Dictionary Tester', email: `owner@${tenantId}.test.invalid`, password });
    connectionId = (await activateConnection(app, { tenantId, principalId: userId, connectorType: 'sql_server', sourceRef: 'dictionary-sqlserver' })).connectionId;
    await runProfile(app, { tenantId, connectionId, connector, jobType: 'profile' });
    server = await buildServer({ pool: app, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email: `owner@${tenantId}.test.invalid` }], testConnectorFor: (ref) => ref === 'dictionary-sqlserver' ? connector : null });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email: `owner@${tenantId}.test.invalid`, password } })).headers['set-cookie']).split(';')[0]!;
  }, 120_000);
  afterAll(async () => { await server?.close(); await connector.close(); await app.end(); await migrate.end(); });

  it('c7_dictionary_lists_standard_and_custom_objects_as_in_the_testbed', async () => {
    const standard = await get(`/api/connections/${connectionId}/dictionary/objects?tab=standard`);
    const custom = await get(`/api/connections/${connectionId}/dictionary/objects?tab=custom`);
    const names = (body: { groups: Array<{ label: string; items: Array<{ name: string }> }> }, label: string) => body.groups.find((group) => group.label === label)?.items.map((item) => item.name) ?? [];
    expect(names(standard, 'Tables')).toEqual(truth.standardTables);
    expect(names(custom, 'Custom tables')).toEqual(truth.customTables);
    expect(names(custom, 'Custom views')).toEqual(truth.customViews);
    for (const [name, procedure] of Object.entries(truth.procedures)) expect(names(custom, procedure.group), name).toContain(name);
    expect(standard.hasVendorDictionary).toBe(false);
  });

  it('c7_dictionary_procedure_details_match_the_parsed_truth', async () => {
    for (const [name, expected] of Object.entries(truth.procedures)) {
      const detail = await get(`/api/connections/${connectionId}/dictionary/object?name=${encodeURIComponent(name)}`);
      expect(detail.definition.encrypted, name).toBe(expected.encrypted);
      expect(detail.definition.parameters.map((parameter: { name: string }) => parameter.name), name).toEqual(expected.parameters);
      expect(detail.definition.parameters.every((parameter: { declared: boolean }) => parameter.declared)).toBe(true);
      if (expected.encrypted) { expect(detail.definition.text).toBeNull(); expect(detail.definition.originalAvailable).toBe(false); continue; }
      expect(detail.definition.writes, name).toEqual(expected.writes);
      expect(detail.definition.reads, name).toEqual(expected.reads);
      expect(detail.definition.calls, name).toEqual(expected.calls);
      if (expected.calledBy) expect(detail.definition.calledBy).toEqual(expected.calledBy);
    }
  });

  it('c7_dictionary_tables_show_keys_joins_and_who_builds_them', async () => {
    const encounters = await get(`/api/connections/${connectionId}/dictionary/object?name=dbo.encounters`);
    expect(encounters.keys.map((key: { column: string; references: string }) => [`dbo.encounters.${key.column}`, key.references]).sort()).toEqual([...truth.foreignKeys].sort());
    expect(encounters.columns.filter((column: { key: boolean }) => column.key).map((column: { name: string }) => column.name).sort()).toEqual(['department_id', 'patient_id']);
    const flags = await get(`/api/connections/${connectionId}/dictionary/object?name=dbo.X_READMIT_FLAGS`);
    expect(flags.custom).toBe(true);
    expect(flags.stats.builtBy).toEqual(['dbo.usp_X_LOAD_READMIT_FLAGS']);
    expect(flags.description).toMatchObject({ origin: 'drafted' });
    expect(flags.description.text).toContain('Loaded by usp_X_LOAD_READMIT_FLAGS');
    const secret = await get(`/api/connections/${connectionId}/dictionary/object?name=dbo.usp_X_SECRET_SCORE`);
    expect(secret.description.text).toContain('encrypts');
  });

  it('c7_stored_definitions_hold_no_literal_values_and_show_original_is_live_only', async () => {
    const stored = await withTenant(migrate, tenantId, (db) => db.query<{ scrubbed_text: string | null; parameters: unknown; analysis: unknown }>('SELECT scrubbed_text,parameters,analysis FROM graph.definitions WHERE tenant_id=$1', [tenantId]));
    expect(stored.rows.length).toBe(Object.keys(truth.procedures).length + truth.customViews.length);
    for (const literal of truth.hardCodedLiterals) expect(JSON.stringify(stored.rows)).not.toContain(literal);
    const loader = await get(`/api/connections/${connectionId}/dictionary/object?name=dbo.usp_X_LOAD_READMIT_FLAGS`);
    expect(loader.definition.text).toContain('<number>'); expect(loader.definition.literalsHidden).toBe(true);
    const original = await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/dictionary/original?name=dbo.usp_X_LOAD_READMIT_FLAGS`, headers: { cookie } });
    expect(original.statusCode).toBe(200); expect(original.headers['cache-control']).toBe('no-store');
    expect(original.json().text).toContain('104233');
    const after = await withTenant(migrate, tenantId, (db) => db.query('SELECT scrubbed_text FROM graph.definitions WHERE tenant_id=$1', [tenantId]));
    expect(JSON.stringify(after.rows)).not.toContain('104233');
    const encrypted = await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/dictionary/original?name=dbo.usp_X_SECRET_SCORE`, headers: { cookie } });
    expect(encrypted.statusCode).toBe(409); expect(encrypted.json()).toEqual({ error: 'definition_encrypted' });
  });

  it('c7_dictionary_search_finds_names_columns_and_sql_lines', async () => {
    const byName = await get(`/api/connections/${connectionId}/dictionary/objects?tab=custom&q=census`);
    expect(byName.groups.flatMap((group: { items: Array<{ name: string }> }) => group.items.map((item) => item.name))).toEqual(expect.arrayContaining(['dbo.X_CENSUS_SNAP', 'dbo.usp_X_MERGE_CENSUS']));
    const byColumn = await get(`/api/connections/${connectionId}/dictionary/objects?tab=standard&q=admitted`);
    expect(byColumn.groups[0].items).toEqual([expect.objectContaining({ name: 'dbo.encounters', matchedColumns: 1 })]);
    const inSql = await get(`/api/connections/${connectionId}/dictionary/objects?tab=custom&q=${truth.sqlSearch.query}`);
    const hit = inSql.sqlHits.find((item: { name: string }) => item.name === truth.sqlSearch.object);
    expect(hit.lines.length).toBeGreaterThan(0);
    expect(hit.lines[0]).toMatchObject({ line: expect.any(Number), text: expect.stringContaining(truth.sqlSearch.query) });
  });

  it('c6_description_approval_is_recorded_with_person_and_time', async () => {
    const response = await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/dictionary/description`, headers: { cookie }, payload: { name: 'dbo.X_JOB_LOG', action: 'edit', text: 'One row per scheduled job run.' } });
    expect(response.statusCode).toBe(404); // No draft until the object has been opened.
    await get(`/api/connections/${connectionId}/dictionary/object?name=dbo.X_JOB_LOG`);
    const edited = await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/dictionary/description`, headers: { cookie }, payload: { name: 'dbo.X_JOB_LOG', action: 'edit', text: 'One row per scheduled job run.' } });
    expect(edited.statusCode).toBe(200);
    const detail = await get(`/api/connections/${connectionId}/dictionary/object?name=dbo.X_JOB_LOG`);
    expect(detail.description).toMatchObject({ text: 'One row per scheduled job run.', origin: 'edited', by: 'Dictionary Tester' });
    expect(Date.parse(detail.description.at)).toBeGreaterThan(Date.now() - 60_000);
    const summary = await get(`/api/connections/${connectionId}/dictionary/summary`);
    expect(summary.coverage.tables.documented).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import type { ReadOnlyConnector } from '@scaleinsyght/connectors';
import { withTenant } from '@scaleinsyght/db';
import { captureDefinitions } from '@scaleinsyght/profiler';
import { activateConnection } from '@scaleinsyght/registry';
import { createTenant } from '../../scripts/tenant-create.js';
import { buildTestServer } from '../support/test-api.js';

// Contract 7 for the Dictionary (decision 53, spec 2.5 and 2.7). Real PostgreSQL; the source connector is a stand-in
// that returns definition text, because what is tested is what gets stored and exported.
config({ path: '.env' });
const testUrl = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); };
const app = new Pool({ connectionString: testUrl('DATABASE_URL') }); const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });
const tenantId = `dictionary-contract-${randomUUID()}`; const password = 'dictionary-contract-password-2026';
let principal = ''; let connectionId = '';
const LITERAL_ID = '104233'; const LITERAL_TEXT = 'Synthetic Patient Seven';

const source = {
  type: 'sql_server',
  async viewDefinitions() { return [{ qualifiedName: 'dbo.v_patients', definition: `CREATE VIEW dbo.v_patients AS SELECT patient_id FROM dbo.patients WHERE patient_id <> ${LITERAL_ID} -- ${LITERAL_TEXT}` }, { qualifiedName: 'dbo.BH_NOTES_V', definition: 'CREATE VIEW dbo.BH_NOTES_V AS SELECT 1 AS x' }]; },
  async routines() { return [
    { qualifiedName: 'dbo.usp_X_LOAD', kind: 'procedure' as const, definition: `CREATE PROCEDURE dbo.usp_X_LOAD AS INSERT INTO dbo.X_FLAGS SELECT patient_id FROM dbo.patients WHERE full_name = N'${LITERAL_TEXT}' OR patient_id = ${LITERAL_ID}`, encrypted: false, parameters: [] },
    { qualifiedName: 'dbo.usp_X_SECRET', kind: 'procedure' as const, definition: null, encrypted: true, parameters: [] },
    { qualifiedName: 'dbo.usp_BH_ONLY', kind: 'procedure' as const, definition: `CREATE PROCEDURE dbo.usp_BH_ONLY AS SELECT ${LITERAL_ID}`, encrypted: false, parameters: [] },
  ]; },
} as unknown as ReadOnlyConnector;

async function seedTable(db: { query: Pool['query'] }, name: string, fields: Array<{ name: string; tags: string[]; nullRate: number | null; distinct: number | null }>) {
  const fingerprint = (value: string) => createHash('sha256').update(`${connectionId}\0${value}`).digest();
  const dataset = (await db.query<{ asset_id: string }>(`INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,'dataset',$3,$4) RETURNING asset_id`, [tenantId, connectionId, name, fingerprint(name)])).rows[0]!.asset_id;
  await db.query(`INSERT INTO graph.asset_versions(tenant_id,asset_id,version,structural_attributes,statistics) VALUES($1,$2,1,$3::jsonb,$4::jsonb)`, [tenantId, dataset, JSON.stringify({ object_type: 'table', columns: fields.map((field) => ({ name: field.name, data_type: 'int', nullable: true })) }), JSON.stringify({ row_count: 3 })]);
  for (const field of fields) {
    const id = (await db.query<{ asset_id: string }>(`INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,'field',$3,$4) RETURNING asset_id`, [tenantId, connectionId, `${name}.${field.name}`, fingerprint(`${name}.${field.name}`)])).rows[0]!.asset_id;
    await db.query(`INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'structural','CONTAINS',$2,$3,'field')`, [tenantId, dataset, id]);
    await db.query(`INSERT INTO graph.asset_versions(tenant_id,asset_id,version,structural_attributes) VALUES($1,$2,1,$3::jsonb)`, [tenantId, id, JSON.stringify({ object_type: 'field', data_type: 'int', nullable: true, sensitivity_tags: field.tags })]);
    // A stored statistic on a tagged field (as an older profile might hold) must still never be shown or exported.
    await db.query(`INSERT INTO profiler.field_profiles(tenant_id,asset_id,profile_version,field_name,data_type,is_nullable,sensitivity_tags,null_rate,distinct_count) VALUES($1,$2,1,$3,'int',true,$4,$5,$6)`, [tenantId, id, field.name, field.tags, field.nullRate, field.distinct]);
  }
}

describe('contract 7 Dictionary definitions and export', () => {
  beforeAll(async () => {
    principal = (await createTenant(migrate, { tenantId, name: 'Dictionary contract', displayName: 'Dictionary Owner', email: `owner@${tenantId}.test.invalid`, password })).userId;
    connectionId = (await activateConnection(app, { tenantId, principalId: principal, connectorType: 'sql_server' })).connectionId;
    await withTenant(migrate, tenantId, async (db) => {
      await seedTable(db, 'dbo.patients', [{ name: 'patient_id', tags: [], nullRate: 0, distinct: 3 }, { name: 'mrn', tags: ['personal'], nullRate: 0.25, distinct: 777 }]);
      await seedTable(db, 'dbo.v_patients', [{ name: 'patient_id', tags: [], nullRate: 0, distinct: 3 }]);
      await db.query(`INSERT INTO registry.connection_scopes(tenant_id,connection_id,qualified_name,object_type,scope_mode) VALUES($1,$2,'dbo.BH_NOTES','table','exclude'),($1,$2,'dbo.usp_BH_ONLY','procedure','list_only')`, [tenantId, connectionId]);
    });
    await captureDefinitions(app, { tenantId, connectionId, connector: source });
  });
  afterAll(async () => { await app.end(); await migrate.end(); });

  it('c7_stored_definitions_replace_literals_and_skip_out_of_scope_objects', async () => {
    const rows = await withTenant(migrate, tenantId, (db) => db.query<{ qualified_name: string; scrubbed_text: string | null; encrypted: boolean }>('SELECT qualified_name,scrubbed_text,encrypted FROM graph.definitions WHERE tenant_id=$1 ORDER BY 1', [tenantId]));
    expect(rows.rows.map((row) => row.qualified_name)).toEqual(['dbo.usp_X_LOAD', 'dbo.usp_X_SECRET', 'dbo.v_patients']);
    expect(rows.rows.find((row) => row.qualified_name === 'dbo.usp_X_SECRET')).toMatchObject({ encrypted: true, scrubbed_text: null });
    const stored = JSON.stringify(rows.rows);
    expect(stored).not.toContain(LITERAL_ID); expect(stored).not.toContain(LITERAL_TEXT);
    expect(rows.rows.find((row) => row.qualified_name === 'dbo.usp_X_LOAD')!.scrubbed_text).toContain("full_name = '<string>' OR patient_id = <number>");
    // Unchanged text keeps its version; nothing is rewritten.
    expect(await captureDefinitions(app, { tenantId, connectionId, connector: source })).toMatchObject({ changed: 0 });
  });

  it('c7_dictionary_export_has_no_row_data_or_withheld_statistics_and_lists_out_of_scope_by_name', async () => {
    const server = await buildTestServer({ pool: app, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email: `owner@${tenantId}.test.invalid` }] });
    try {
      const cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email: `owner@${tenantId}.test.invalid`, password } })).headers['set-cookie']).split(';')[0]!;
      expect((await server.inject({ method: 'POST', url: '/api/dictionary/export-html', headers: { cookie }, payload: { connectionIds: [connectionId] } })).statusCode).toBe(400);
      const response = await server.inject({ method: 'POST', url: '/api/dictionary/export-html', headers: { cookie }, payload: { connectionIds: [connectionId], acknowledged: true } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      const html = response.body;
      // Item 5: the export carries the page's own data: the object list, and each object's detail as the API returns it.
      const data = JSON.parse(/<script type="application\/json" id="dictionary-data">([\s\S]*?)<\/script>/.exec(html)![1]!) as { sources: Array<{ objects: Array<{ name: string }>; details: Record<string, { columns: Array<{ name: string; statsWithheld: boolean; nullRate: number | null; distinctCount: number | null }> }>; outOfScope: Array<{ name: string; type: string }> }> };
      const objects = data.sources[0]!.objects;
      const mrn = data.sources[0]!.details['dbo.patients']!.columns.find((column) => column.name === 'mrn')!;
      expect(mrn).toMatchObject({ statsWithheld: true, nullRate: null, distinctCount: null });
      expect(html).not.toContain('777'); expect(html).not.toContain('0.25');
      expect(html).not.toContain(LITERAL_ID); expect(html).not.toContain(LITERAL_TEXT);
      // Out-of-scope objects: by name and type only, never listed or detailed.
      for (const name of ['dbo.BH_NOTES', 'dbo.usp_BH_ONLY']) { expect(objects.map((object) => object.name)).not.toContain(name); expect(Object.keys(data.sources[0]!.details)).not.toContain(name); }
      expect(data.sources[0]!.outOfScope).toEqual(expect.arrayContaining([{ name: 'dbo.BH_NOTES', type: 'table' }, { name: 'dbo.usp_BH_ONLY', type: 'procedure' }]));
      // No web address outside the embedded fonts' licence comments.
      expect(html.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/https?:\/\//);
      const audit = await withTenant(migrate, tenantId, (db) => db.query<{ principal_id: string; safe_details: Record<string, unknown> }>(`SELECT principal_id,safe_details FROM core.activity_events WHERE tenant_id=$1 AND event_type='dictionary_exported'`, [tenantId]));
      expect(audit.rows).toEqual([{ principal_id: principal, safe_details: { sources: 1, objects: objects.length + 2, format: 'html' } }]);
      const detail = await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/dictionary/object?name=dbo.patients`, headers: { cookie } });
      expect(detail.json().columns.find((column: { name: string }) => column.name === 'mrn')).toMatchObject({ statsWithheld: true, nullRate: null, distinctCount: null });
    } finally { await server.close(); }
  });

  it('c1_dictionary_tables_are_isolated_per_tenant', async () => {
    const other = `dictionary-other-${randomUUID()}`;
    await createTenant(migrate, { tenantId: other, name: 'Other', displayName: 'Other Owner', email: `owner@${other}.test.invalid`, password });
    const seen = await withTenant(app, other, (db) => db.query(`SELECT 1 FROM graph.definitions UNION ALL SELECT 1 FROM graph.description_reviews UNION ALL SELECT 1 FROM graph.dictionary_imports UNION ALL SELECT 1 FROM graph.dbt_tests`));
    expect(seen.rowCount).toBe(0);
    const own = await withTenant(app, tenantId, (db) => db.query('SELECT 1 FROM graph.definitions'));
    expect(own.rowCount).toBe(3);
  });
});

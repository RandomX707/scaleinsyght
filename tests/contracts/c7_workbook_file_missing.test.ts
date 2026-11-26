import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { withTenant } from '@scaleinsyght/db';
import { hashPassword } from '@scaleinsyght/api/server';
import { buildTestServer } from '../support/test-api.js';
import { runQueuedDiscoveries } from '../support/discovery.js';

// A workbook whose encrypted file is missing from the artifact volume (for example a volume that moved) is reported
// as "Workbook file not found, upload it again", never as a server error. Real PostgreSQL; nothing is mocked.
config({ path: '.env' });
const testUrl = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; workbook contracts are never skipped`); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); };
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') }); const adminPool = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });
const volume = mkdtempSync(join(tmpdir(), 'si-missing-workbook-'));
const store = new EncryptedArtifactStore(volume, Buffer.alloc(32, 29));
const tenantId = `missing-workbook-${randomUUID()}`; const email = `admin@${tenantId}.synthetic.invalid`; const password = 'missing-workbook-password';
let server: Awaited<ReturnType<typeof buildTestServer>>; let cookie = ''; let connectionId = ''; let artifactId = '';

describe('contract 7 missing workbook file', () => {
  beforeAll(async () => {
    await withTenant(adminPool, tenantId, async (db) => { await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]); await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)', [tenantId, email, hashPassword(password), 'Workbook User']); });
    server = await buildTestServer({ pool: appPool, sessionSecret: 'missing-workbook-contract-secret-0123456789ab', testAccounts: [{ tenantId, email }], artifactStore: store });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).headers['set-cookie']).split(';')[0]!;
    const draft = await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { connectorType: 'excel', displayName: 'Operations workbook' } });
    connectionId = draft.json<{ connectionId: string }>().connectionId;
    const uploaded = await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/workbooks`, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: readFileSync('testbed/excel/hospital-operations.xlsx') });
    expect(uploaded.statusCode).toBe(201); artifactId = uploaded.json<{ artifactId: string }>().artifactId;
    expect((await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/activate`, headers: { cookie }, payload: { scope: [] } })).statusCode).toBe(200);
    await runQueuedDiscoveries(tenantId, store);
  }, 60_000);
  afterAll(async () => { await server?.close(); await appPool.end(); await adminPool.end(); rmSync(volume, { recursive: true, force: true }); });

  it('c7_refresh_with_a_missing_workbook_file_asks_for_it_again_instead_of_failing', async () => {
    const refresh = () => server.inject({ method: 'POST', url: `/api/connections/${connectionId}/discover`, headers: { cookie }, payload: { jobType: 'nightly' } });
    expect((await refresh()).statusCode).toBe(200);
    const directory = join(volume, store.tenantDirectory(tenantId));
    for (const file of readdirSync(directory)) rmSync(join(directory, file));
    const missing = await refresh();
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toEqual({ error: 'workbook_file_missing', message: 'Workbook file not found, upload it again' });
    const download = await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/workbooks/${artifactId}`, headers: { cookie } });
    expect(download.statusCode).toBe(409);
    expect(download.json()).toMatchObject({ error: 'workbook_file_missing' });
  });
});

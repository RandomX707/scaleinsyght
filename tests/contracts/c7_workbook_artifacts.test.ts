import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { readWorkbook, retireConnection, storeWorkbook } from '@scaleinsyght/profiler';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value);
  url.pathname = '/si_test';
  return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

async function createTenant(tenantId: string): Promise<string> {
  return withTenant(migrate, tenantId, async (client) => {
    await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
    const user = await client.query<{ user_id: string }>(
      `INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic-hash') RETURNING user_id`,
      [tenantId, `${tenantId}@synthetic.example`],
    );
    return user.rows[0]!.user_id;
  });
}

describe('contract 7 encrypted workbook storage', () => {
  afterAll(async () => {
    await app.end();
    await migrate.end();
  });

  it('c7_workbook_is_encrypted_tenant_scoped_and_deleted_when_connector_is_removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'si-workbook-contract-'));
    try {
      const store = new EncryptedArtifactStore(root, Buffer.alloc(32, 19));
      const tenantA = `workbook-a-${crypto.randomUUID()}`;
      const tenantB = `workbook-b-${crypto.randomUUID()}`;
      const userA = await createTenant(tenantA);
      const userB = await createTenant(tenantB);
      const connectionA = await activateConnection(app, { tenantId: tenantA, principalId: userA, connectorType: 'excel' });
      const connectionB = await activateConnection(app, { tenantId: tenantB, principalId: userB, connectorType: 'excel' });
      const bytes = Buffer.from('synthetic Riverside workbook contents');
      const artifact = await storeWorkbook(app, store, { tenantId: tenantA, connectionId: connectionA.connectionId, bytes });
      const encryptedDirectory = join(root, store.tenantDirectory(tenantA));
      const encryptedFile = await readdir(encryptedDirectory);
      const ciphertext = await readFile(join(encryptedDirectory, encryptedFile[0]!));
      expect(ciphertext.includes(bytes)).toBe(false);
      expect(await readWorkbook(app, store, { tenantId: tenantA, connectionId: connectionA.connectionId, artifactId: artifact.artifactId })).toEqual(bytes);
      await expect(readWorkbook(app, store, { tenantId: tenantB, connectionId: connectionB.connectionId, artifactId: artifact.artifactId })).rejects.toThrow('workbook_not_found');

      const storedColumns = await withTenant(migrate, tenantA, async (client) => client.query<{ columns: string[] }>(
        `SELECT array_agg(column_name ORDER BY column_name) AS columns FROM information_schema.columns
         WHERE table_schema='artifacts' AND table_name='workbooks'`,
      ));
      expect(storedColumns.rows[0]!.columns).not.toContain('plaintext');

      await retireConnection(app, store, { tenantId: tenantA, connectionId: connectionA.connectionId, principalId: userA });
      await expect(readWorkbook(app, store, { tenantId: tenantA, connectionId: connectionA.connectionId, artifactId: artifact.artifactId })).rejects.toThrow('workbook_not_found');
      expect(await readdir(encryptedDirectory)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { buildServer } from '@scaleinsyght/api/server';
import { createTenant } from '../../scripts/tenant-create.js';

// The Dictionary list loads 200 objects per group and "Show N more" pages through the rest. Generic fixture: 230 tables.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') }); const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const schema = `wide_${randomUUID().replaceAll('-', '').slice(0, 10)}`; const mine = (name: string) => name.startsWith(`${schema}.`);
const tenantId = `wide-${randomUUID()}`; const email = `owner@${tenantId}.test.invalid`; const password = 'wide-password-1';
let server: Awaited<ReturnType<typeof buildServer>>; let cookie = ''; let connectionId = '';
function scoped(): ReadOnlyConnector {
  const real = createPostgresConnector({ connectionString: url('DATABASE_URL_MIGRATE'), statementTimeoutMs: 10_000 });
  return new Proxy(real, { get: (target, key) => {
    if (key === 'discover') return async (input: Parameters<ReadOnlyConnector['discover']>[0]) => { const found = await target.discover(input); const objects = found.objects.filter((object) => mine(object.qualifiedName));
      return { ...found, objects, unchangedObjects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: objects.length, accessible: objects.length, inaccessible: 0 } }; };
    if (['routines', 'viewDefinitions', 'objectOrigins', 'structuralReferences'].includes(String(key))) return async () => [];
    const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value;
  } }) as ReadOnlyConnector;
}
type Page = { groups: Array<{ key: string; total: number; items: Array<{ name: string }>; nextOffset: number | null }> };
const list = async (query: string) => (await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/dictionary/objects?${query}`, headers: { cookie } })).json<Page>();

describe('contract 6 Dictionary list pages past 200', () => {
  beforeAll(async () => {
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    await migratePool.query(`CREATE SCHEMA ${schema}; ${Array.from({ length: 230 }, (_, index) => `CREATE TABLE ${schema}.t${String(index).padStart(3, '0')}(id integer);`).join(' ')}`);
    const { userId } = await createTenant(migratePool, { tenantId, name: 'Wide', displayName: 'Wide Tester', email, password });
    connectionId = (await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' })).connectionId;
    const connector = scoped();
    try { await runProfile(appPool, { tenantId, connectionId, connector, jobType: 'discovery' }); } finally { await connector.close?.(); }
    server = await buildServer({ pool: appPool, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
  }, 300_000);
  afterAll(async () => { await server?.close(); await migratePool.query(`DROP SCHEMA ${schema} CASCADE`); await appPool.end(); await migratePool.end(); });

  it('c6_the_first_200_then_the_rest_with_no_gap_or_repeat', async () => {
    const first = (await list('tab=standard')).groups[0]!;
    expect(first).toMatchObject({ key: 'tables', total: 230, nextOffset: 200 });
    expect(first.items).toHaveLength(200);
    const rest = (await list(`tab=standard&group=tables&offset=${first.nextOffset}`)).groups[0]!;
    expect(rest.items).toHaveLength(30); expect(rest.nextOffset).toBeNull();
    const names = [...first.items, ...rest.items].map((item) => item.name);
    expect(new Set(names).size).toBe(230);
    expect(names).toEqual(Array.from({ length: 230 }, (_, index) => `${schema}.t${String(index).padStart(3, '0')}`));
  });
});

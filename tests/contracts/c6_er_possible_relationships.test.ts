import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';
import { buildTestServer } from '../support/test-api.js';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString();
}
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') });
const migratePool = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

type Er = { relationships: Array<{ from_name: string; to_name: string; evidence_method: string; confidence_score: string | number; low_confidence: boolean }> };

describe('contract 6 ER possible relationships (decision 38)', () => {
  afterAll(async () => { await appPool.end(); await migratePool.end(); });
  it('er_possible_relationships_are_hidden_by_default_and_labelled_low_confidence_on_request', async () => {
    const tenantId = `er-possible-${randomUUID()}`; const email = `${tenantId}@synthetic.example`;
    const connectionId = await withTenant(migratePool, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)', [tenantId, email, hashPassword('synthetic-password')]);
      const connection = await db.query<{ connection_id: string }>("INSERT INTO registry.connections(tenant_id,connector_type,status,display_name) VALUES($1,'postgres','draft','Synthetic source') RETURNING connection_id", [tenantId]);
      const id = connection.rows[0]!.connection_id;
      const asset = async (type: 'dataset' | 'field', name: string) => (await db.query<{ asset_id: string }>('INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,$3,$4,$5) RETURNING asset_id', [tenantId, id, type, name, randomBytes(32)])).rows[0]!.asset_id;
      const reference = async (from: string, to: string, method: 'declared' | 'inferred', confidence: number) => {
        const relationship = await db.query<{ relationship_id: string }>("INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'structural','REFERENCES',$2,$3,'field') RETURNING relationship_id", [tenantId, from, to]);
        const evidence = await db.query<{ evidence_id: string }>("INSERT INTO graph.evidence(tenant_id,evidence_type) VALUES($1,'inferred_reference') RETURNING evidence_id", [tenantId]);
        await db.query("INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,confidence_score,collector_version) VALUES($1,$2,$3,$4,$5,'contract-test')", [tenantId, relationship.rows[0]!.relationship_id, method, [evidence.rows[0]!.evidence_id], confidence]);
      };
      for (const table of ['public.orders', 'public.departments', 'public.wards']) await asset('dataset', table);
      const [orderDepartment, departmentId, orderWard, wardId, orderBed] = [await asset('field', 'public.orders.department_id'), await asset('field', 'public.departments.department_id'),
        await asset('field', 'public.orders.ward_id'), await asset('field', 'public.wards.ward_id'), await asset('field', 'public.orders.bed_id')];
      await reference(orderDepartment, departmentId, 'declared', 1);
      await reference(orderWard, wardId, 'inferred', 0.72);
      await reference(orderBed, wardId, 'inferred', 0.4);
      return id;
    });
    const server = await buildTestServer({ pool: appPool, sessionSecret: 'e'.repeat(64), testAccounts: [{ tenantId, email }] });
    try {
      const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']);
      const shown = (await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/er`, headers: { cookie } })).json<Er>().relationships;
      expect(shown.map((item) => [item.from_name, item.low_confidence])).toEqual([['public.orders.department_id', false]]);
      const possible = (await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/er?possible=true`, headers: { cookie } })).json<Er>().relationships;
      expect(possible.map((item) => [item.from_name, item.evidence_method, Number(item.confidence_score), item.low_confidence])).toEqual([
        ['public.orders.bed_id', 'inferred', 0.4, true],
        ['public.orders.department_id', 'declared', 1, false],
        ['public.orders.ward_id', 'inferred', 0.72, true],
      ]);
    } finally { await server.close(); }
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { getPersonalMemory, putPersonalMemory, deletePersonalMemory, createGovernedDraft, approveGovernedVersion, getApprovedGovernedVersion } from '@scaleinsyght/registry';

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

async function createPeople(tenantId: string): Promise<[string, string]> {
  return withTenant(migrate, tenantId, async (client) => {
    await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
    const first = await client.query<{ user_id: string }>(
      "INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id",
      [tenantId, `${tenantId}-a@synthetic.example`],
    );
    const second = await client.query<{ user_id: string }>(
      "INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id",
      [tenantId, `${tenantId}-b@synthetic.example`],
    );
    return [first.rows[0]!.user_id, second.rows[0]!.user_id];
  });
}

describe('contract 2 personal memory and governed definitions', () => {
  afterAll(async () => {
    await app.end();
    await migrate.end();
  });

  it('c2_personal_memory_is_owner_only_editable_and_deletable', async () => {
    const tenantId = `memory-owner-${crypto.randomUUID()}`;
    const [ownerId, otherId] = await createPeople(tenantId);
    const memory = { vocabulary: { turnover: 'net revenue' }, defaultSources: [], savedPlanIds: [], answerStyle: 'concise' as const, corrections: [] };
    const entitlementCount = await withTenant(migrate, tenantId, (client) => client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.entitlements WHERE tenant_id=$1', [tenantId],
    ));
    await putPersonalMemory(app, { tenantId, principalId: ownerId, memory });
    const afterWrite = await withTenant(migrate, tenantId, (client) => client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.entitlements WHERE tenant_id=$1', [tenantId],
    ));
    expect(afterWrite.rows[0]?.count).toBe(entitlementCount.rows[0]?.count);
    expect(await getPersonalMemory(app, { tenantId, principalId: otherId })).toEqual({ vocabulary: {}, defaultSources: [], savedPlanIds: [], answerStyle: null, corrections: [] });
    expect(await getPersonalMemory(app, { tenantId, principalId: ownerId })).toEqual(memory);
    expect(await deletePersonalMemory(app, { tenantId, principalId: ownerId })).toBe(true);
    expect(await getPersonalMemory(app, { tenantId, principalId: ownerId })).toEqual({ vocabulary: {}, defaultSources: [], savedPlanIds: [], answerStyle: null, corrections: [] });
  });

  it('c2_personal_memory_schema_has_no_role_or_persona_field', async () => {
    await createPeople(`memory-schema-${crypto.randomUUID()}`);
    const columns = await migrate.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='registry' AND table_name='personal_memories' ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('role_template');
  });

  it('c2_governed_definition_versions_are_immutable_and_approval_is_version_bound', async () => {
    const tenantId = `governed-${crypto.randomUUID()}`;
    const [ownerId] = await createPeople(tenantId);
    const plan = { plan: 'synthetic-read-only-v1', output: { metric: 'profiled_count' } };
    const draft = await createGovernedDraft(app, { tenantId, principalId: ownerId, name: 'Synthetic profile summary', plan });
    const approval = await approveGovernedVersion(app, { tenantId, principalId: ownerId, governedId: draft.governedId, version: draft.version });
    const approved = await getApprovedGovernedVersion(app, { tenantId, governedId: draft.governedId, version: draft.version });
    expect(approved).toMatchObject({ version: 1, status: 'approved', plan });
    expect(approval.version).toBe(1);
    await expect(withTenant(migrate, tenantId, (client) => client.query(
      `UPDATE registry.governed_versions SET plan='{}'::jsonb WHERE tenant_id=$1 AND governed_id=$2 AND version=1`,
      [tenantId, draft.governedId],
    ))).rejects.toThrow('governed versions are immutable');
    await expect(approveGovernedVersion(app, { tenantId, principalId: ownerId, governedId: draft.governedId, version: 2 })).rejects.toThrow('governed_version_not_found');
  });
});

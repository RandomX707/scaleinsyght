import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { buildServer } from '@scaleinsyght/api/server';
import { provisionTestTenant } from '../support/tenant.js';

config({ path: '.env' });
function databaseUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = '/si_test'; return url.toString();
}
const appPool = new Pool({ connectionString: databaseUrl('DATABASE_URL'), max: 2 });
const migratePool = new Pool({ connectionString: databaseUrl('DATABASE_URL_MIGRATE'), max: 1 });
const suffix = randomUUID();
const workspaceA = `s1-tenant-a-${suffix}`;
const workspaceB = `s1-tenant-b-${suffix}`;
let server: Awaited<ReturnType<typeof buildServer>>;
let sessionA = '';

describe('contract 1 tenant creation and invitation', () => {
  beforeAll(async () => {
    await provisionTestTenant(migratePool, { tenantId: workspaceA, displayName: 'Workspace Owner', email: 'owner@example.invalid', password: 'First-User-Password-A1!' });
    await provisionTestTenant(migratePool, { tenantId: workspaceB, displayName: 'Workspace Owner', email: 'owner@example.invalid', password: 'First-User-Password-B2!' });
    server = await buildServer({ pool: appPool, sessionSecret: 't'.repeat(64), testAccounts: [] });
    const a = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId: workspaceA, email: 'owner@example.invalid', password: 'First-User-Password-A1!' } });
    const b = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId: workspaceB, email: 'owner@example.invalid', password: 'First-User-Password-B2!' } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    sessionA = String(a.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => { await server?.close(); await appPool.end(); await migratePool.end(); });

  it('c1_tenant_create_provisions_no_product_records', async () => {
    for (const tenantId of [workspaceA, workspaceB]) {
      const rows = await withTenant(migratePool, tenantId, async (db) => db.query<{ connections: number; jobs: number; assets: number; findings: number; saved_questions: number; approvals: number; runs: number; reports: number }>(`SELECT
        (SELECT count(*)::integer FROM registry.connections WHERE tenant_id=$1) AS connections,
        (SELECT count(*)::integer FROM profiler.jobs WHERE tenant_id=$1) AS jobs,
        (SELECT count(*)::integer FROM graph.assets WHERE tenant_id=$1) AS assets,
        (SELECT count(*)::integer FROM core.notifications WHERE tenant_id=$1) AS findings,
        (SELECT count(*)::integer FROM registry.personal_memories WHERE tenant_id=$1 AND jsonb_array_length(saved_plan_ids)>0) AS saved_questions,
        ((SELECT count(*)::integer FROM registry.governed_approvals WHERE tenant_id=$1) + (SELECT count(*)::integer FROM hub.flowspec_approvals WHERE tenant_id=$1)) AS approvals,
        (SELECT count(*)::integer FROM runs.runs WHERE tenant_id=$1) AS runs,
        (SELECT count(*)::integer FROM reports.definitions WHERE tenant_id=$1) AS reports`, [tenantId]));
      expect(rows.rows[0]).toEqual({ connections: 0, jobs: 0, assets: 0, findings: 0, saved_questions: 0, approvals: 0, runs: 0, reports: 0 });
    }
  });

  it('c1_password_login_is_workspace_scoped', async () => {
    const wrongWorkspace = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId: workspaceB, email: 'owner@example.invalid', password: 'First-User-Password-A1!' } });
    const rightWorkspace = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId: workspaceB, email: 'owner@example.invalid', password: 'First-User-Password-B2!' } });
    expect(wrongWorkspace.statusCode).toBe(401);
    expect(wrongWorkspace.json()).toEqual({ error: 'invalid_credentials' });
    expect(rightWorkspace.statusCode).toBe(200);
    expect(rightWorkspace.json().user).toMatchObject({ email: 'owner@example.invalid', displayName: 'Workspace Owner' });
    const profile = await server.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionA } });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().user).toMatchObject({ email: 'owner@example.invalid', displayName: 'Workspace Owner' });
  });

  it('c1_invite_is_hashed_expires_and_is_single_use', async () => {
    const issued = await server.inject({ method: 'POST', url: '/api/tenant/invites', headers: { cookie: sessionA }, payload: { email: 'member@example.invalid' } });
    expect(issued.statusCode).toBe(201);
    const inviteUrl = new URL(issued.json().inviteUrl);
    const token = inviteUrl.searchParams.get('token')!;
    const tokenHash = createHash('sha256').update(token).digest();
    const stored = await withTenant(migratePool, workspaceA, db => db.query<{ token_hash: Buffer; expires_at: Date }>('SELECT token_hash,expires_at FROM core.tenant_invites WHERE tenant_id=$1', [workspaceA]));
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.token_hash.equals(tokenHash)).toBe(true);
    expect(stored.rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(stored.rows[0]!.expires_at.getTime()).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
    const accepted = await server.inject({ method: 'POST', url: '/api/auth/invites/accept', payload: { tenantId: workspaceA, token, displayName: 'Invited Member', password: 'Invited-Password-Alpha1!' } });
    expect(accepted.statusCode).toBe(201);
    const replay = await server.inject({ method: 'POST', url: '/api/auth/invites/accept', payload: { tenantId: workspaceA, token, displayName: 'Invited Member', password: 'Invited-Password-Alpha1!' } });
    expect(replay.statusCode).toBe(400);
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId: workspaceA, email: 'member@example.invalid', password: 'Invited-Password-Alpha1!' } });
    expect(login.statusCode).toBe(200);
    const memberCookie = String(login.headers['set-cookie']).split(';')[0]!;
    const memberInvite = await server.inject({ method: 'POST', url: '/api/tenant/invites', headers: { cookie: memberCookie }, payload: { email: 'another@example.invalid' } });
    expect(memberInvite.statusCode).toBe(403);

    const expiring = await server.inject({ method: 'POST', url: '/api/tenant/invites', headers: { cookie: sessionA }, payload: { email: 'expired@example.invalid' } });
    const expiredToken = new URL(expiring.json().inviteUrl).searchParams.get('token')!;
    await withTenant(migratePool, workspaceA, db => db.query('UPDATE core.tenant_invites SET expires_at=clock_timestamp()-interval \'1 second\' WHERE tenant_id=$1 AND token_hash=$2', [workspaceA, createHash('sha256').update(expiredToken).digest()]));
    const expired = await server.inject({ method: 'POST', url: '/api/auth/invites/accept', payload: { tenantId: workspaceA, token: expiredToken, displayName: 'Expired Member', password: 'Expired-Password-Alpha1!' } });
    expect(expired.statusCode).toBe(400);
  });

  it('c1_invite_cannot_cross_tenant', async () => {
    const issued = await server.inject({ method: 'POST', url: '/api/tenant/invites', headers: { cookie: sessionA }, payload: { email: 'cross@example.invalid' } });
    const token = new URL(issued.json().inviteUrl).searchParams.get('token')!;
    const crossTenant = await server.inject({ method: 'POST', url: '/api/auth/invites/accept', payload: { tenantId: workspaceB, token, displayName: 'Cross Tenant', password: 'Cross-Password-Alpha1!' } });
    expect(crossTenant.statusCode).toBe(400);
    const accepted = await server.inject({ method: 'POST', url: '/api/auth/invites/accept', payload: { tenantId: workspaceA, token, displayName: 'Workspace Member', password: 'Cross-Password-Alpha1!' } });
    expect(accepted.statusCode).toBe(201);
  });
});

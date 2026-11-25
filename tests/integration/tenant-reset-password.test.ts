import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { createTenant } from '../../scripts/tenant-create.js';
import { resetPassword } from '../../scripts/tenant-reset-password.js';

config({ path: '.env' });
const value = process.env.DATABASE_URL_MIGRATE;
if (!value) throw new Error('DATABASE_URL_MIGRATE is required; PostgreSQL integration tests are never skipped');
const url = new URL(value); url.pathname = '/si_test';
const pool = new Pool({ connectionString: url.toString() });
const matches = (password: string, encoded: string) => {
  const [salt, hash] = encoded.split(':');
  return timingSafeEqual(scryptSync(password, salt!, 64), Buffer.from(hash!, 'hex'));
};

describe('tenant:reset-password', () => {
  it('tenant_reset_password_sets_a_new_hash_and_signs_out_open_sessions', async () => {
    const tenantId = `reset-${randomUUID()}`; const email = `owner@${tenantId}.test.invalid`;
    const { userId } = await createTenant(pool, { tenantId, name: 'Reset workspace', displayName: 'Owner', email, password: 'original-password-2026' });
    await withTenant(pool, tenantId, (db) => db.query("INSERT INTO core.sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [tenantId, userId, randomBytes(32)]));
    expect(await resetPassword(pool, { tenantId, email: email.toUpperCase(), password: 'replacement-password-2026' })).toEqual({ userId, revokedSessions: 1 });
    const stored = await withTenant(pool, tenantId, (db) => db.query<{ password_hash: string; open: string }>(
      'SELECT password_hash,(SELECT count(*) FROM core.sessions WHERE tenant_id=$1 AND revoked_at IS NULL)::text AS open FROM core.users WHERE tenant_id=$1', [tenantId]));
    expect(matches('replacement-password-2026', stored.rows[0]!.password_hash)).toBe(true);
    expect(matches('original-password-2026', stored.rows[0]!.password_hash)).toBe(false);
    expect(stored.rows[0]!.open).toBe('0');
  });
  it('tenant_reset_password_rejects_unknown_people_and_short_passwords', async () => {
    const tenantId = `reset-${randomUUID()}`;
    await createTenant(pool, { tenantId, name: 'Reset workspace', displayName: 'Owner', email: `owner@${tenantId}.test.invalid`, password: 'original-password-2026' });
    await expect(resetPassword(pool, { tenantId, email: `someone@${tenantId}.test.invalid`, password: 'replacement-password-2026' })).rejects.toThrow('active_user_not_found');
    await expect(resetPassword(pool, { tenantId: 'another-workspace', email: `owner@${tenantId}.test.invalid`, password: 'replacement-password-2026' })).rejects.toThrow('active_user_not_found');
    await expect(resetPassword(pool, { tenantId, email: `owner@${tenantId}.test.invalid`, password: 'short' })).rejects.toThrow('password_too_short');
  });
});

afterAll(async () => { await pool.end(); });

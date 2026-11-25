import { resolve } from 'node:path';
import { stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { askHiddenPassword, hashPassword, normalizeTenantSlug, normalizeUserEmail, validateFirstUserPassword } from './tenant-create.js';

/** Sets a new password for one person in one workspace and revokes their open sessions. Admin command, run as the
 * migration role on the local server: pnpm tenant:reset-password <tenant> <email> [--test]. */
export async function resetPassword(pool: Pool, input: { tenantId: string; email: string; password: string }): Promise<{ userId: string; revokedSessions: number }> {
  const tenantId = normalizeTenantSlug(input.tenantId);
  const email = normalizeUserEmail(input.email);
  validateFirstUserPassword(input.password);
  return withTenant(pool, tenantId, async (db) => {
    const updated = await db.query<{ user_id: string }>('UPDATE core.users SET password_hash=$3 WHERE tenant_id=$1 AND email=$2 AND is_active RETURNING user_id',
      [tenantId, email, hashPassword(input.password)]);
    const userId = updated.rows[0]?.user_id;
    if (!userId) throw new Error('active_user_not_found');
    const revoked = await db.query('UPDATE core.sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL', [tenantId, userId]);
    return { userId, revokedSessions: revoked.rowCount ?? 0 };
  });
}

async function runCli(): Promise<void> {
  config({ path: resolve('.env') });
  const [tenantArg, emailArg] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (!tenantArg || !emailArg) throw new Error('usage: pnpm tenant:reset-password <tenant> <email> [--test]');
  const password = await askHiddenPassword('New password (hidden): ');
  stdout.write('\n');
  if (password !== await askHiddenPassword('Repeat new password (hidden): ')) throw new Error('passwords_do_not_match');
  stdout.write('\n');
  const configured = process.env.DATABASE_URL_MIGRATE;
  if (!configured) throw new Error('DATABASE_URL_MIGRATE is required; run pnpm db:setup first.');
  const databaseUrl = new URL(configured);
  if (process.argv.includes('--test')) databaseUrl.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
  try {
    const result = await resetPassword(pool, { tenantId: tenantArg, email: emailArg, password });
    stdout.write(`Password changed for ${normalizeUserEmail(emailArg)} in ${normalizeTenantSlug(tenantArg)}; ${result.revokedSessions} open session(s) signed out.\n`);
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await runCli(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'password_reset_failed'}\n`);
    process.exitCode = 1;
  }
}

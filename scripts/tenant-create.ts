import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';

export interface CreateTenantInput {
  tenantId: string;
  name: string;
  displayName: string;
  email: string;
  password: string;
}

export function normalizeTenantSlug(value: string): string {
  const slug = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug || slug.length > 80) throw new Error('tenant_name_invalid');
  return slug;
}

export function normalizeUserEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email_invalid');
  return email;
}

export function validateFirstUserPassword(value: string): void {
  if (value.length < 12 || value.length > 1024) throw new Error('password_too_short');
}

function hashPassword(value: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}

export async function createTenant(pool: Pool, input: CreateTenantInput): Promise<{ tenantId: string; userId: string }> {
  const tenantId = normalizeTenantSlug(input.tenantId);
  const name = input.name.trim();
  const displayName = input.displayName.trim();
  const email = normalizeUserEmail(input.email);
  validateFirstUserPassword(input.password);
  if (!name || name.length > 120) throw new Error('tenant_name_invalid');
  if (!displayName || displayName.length > 120) throw new Error('display_name_invalid');
  return withTenant(pool, tenantId, async (db) => {
    await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$2)', [tenantId, name]);
    const user = await db.query<{ user_id: string }>(`INSERT INTO core.users(tenant_id,email,display_name,password_hash)
      VALUES($1,$2,$3,$4) RETURNING user_id`, [tenantId, email, displayName, hashPassword(input.password)]);
    const userId = user.rows[0]!.user_id;
    await db.query(`INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,allowed)
      VALUES ($1,$2,'tenant.member',true),($1,$2,'tenant.admin',true),($1,$2,'tenant.gateway.manage',true),($1,$2,'tenant.sso.configure',true)`, [tenantId, userId]);
    return { tenantId, userId };
  });
}

async function askHiddenPassword(): Promise<string> {
  if (!stdin.isTTY) throw new Error('first_user_password_requires_interactive_terminal');
  const silentOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  stdout.write('First user password (hidden): ');
  const hidden = createInterface({ input: stdin, output: silentOutput, terminal: true });
  try {
    return await hidden.question('');
  } finally { hidden.close(); }
}

async function runCli(): Promise<void> {
  config({ path: resolve('.env') });
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const name = (await rl.question('Workspace name: ')).trim();
    const email = normalizeUserEmail(await rl.question('First user email: '));
    const displayName = (await rl.question('First user display name: ')).trim();
    rl.close();
    const password = await askHiddenPassword();
    const tenantId = normalizeTenantSlug(name);
    const configuredDatabaseUrl = process.env.DATABASE_URL_MIGRATE;
    const databaseUrl = configuredDatabaseUrl ? new URL(configuredDatabaseUrl) : null;
    if (!databaseUrl) throw new Error('DATABASE_URL_MIGRATE is required; run pnpm db:setup first.');
    if (process.argv.includes('--test')) databaseUrl.pathname = '/si_test';
    const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
    try {
      const created = await createTenant(pool, { tenantId, name, displayName, email, password });
      process.stdout.write(`Workspace ID: ${created.tenantId}\nFirst user: ${email}\n`);
    } finally { await pool.end(); }
  } finally { rl.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await runCli(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'tenant_creation_failed'}\n`);
    process.exitCode = 1;
  }
}

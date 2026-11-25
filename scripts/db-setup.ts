import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { Client } from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roleNames = ['si_migrate', 'si_app', 'si_worker'] as const;
const databaseNames = ['scale_insyght', 'si_test'] as const;

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildDatabaseUrl(
  role: string,
  password: string,
  database: string,
  port = 5432,
): string {
  const url = new URL(`postgresql://${role}@127.0.0.1:${port}/${database}`);
  url.password = password;
  return url.toString();
}

function localPassword(): string {
  return randomBytes(32).toString('base64url');
}

export function localArtifactMasterKey(): string {
  return randomBytes(32).toString('base64');
}

function createEnvFile(envPath: string, examplePath: string): void {
  if (existsSync(envPath)) return;

  const appPassword = localPassword();
  const workerPassword = localPassword();
  const migratePassword = localPassword();
  const sessionSecret = randomBytes(48).toString('base64url');
  const contents = readFileSync(examplePath, 'utf8')
    .replace('si_app:replace-me@', `si_app:${appPassword}@`)
    .replace('si_worker:replace-me@', `si_worker:${workerPassword}@`)
    .replace('si_migrate:replace-me@', `si_migrate:${migratePassword}@`)
    .replace('replace-with-a-random-local-secret', sessionSecret)
    .replace('replace-with-base64-for-a-random-32-byte-key', localArtifactMasterKey())
    // One volume per machine, outside any worktree, so every worktree sharing the database reads the same files.
    .replace('replace-with-an-absolute-path', resolve(homedir(), '.scaleinsyght', 'artifacts'));
  writeFileSync(envPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function readRolePassword(urlValue: string | undefined, role: string): string {
  if (!urlValue) throw new Error(`Missing DATABASE_URL configuration for ${role}; check .env.example`);
  const url = new URL(urlValue);
  if (decodeURIComponent(url.username) !== role || url.pathname !== '/scale_insyght') {
    throw new Error(`Database URL for ${role} must point to the Scale Insyght database`);
  }
  return decodeURIComponent(url.password);
}

async function ensureRole(client: Client, role: string, password: string): Promise<void> {
  const existing = await client.query<{
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
       FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  if (existing.rowCount) {
    const current = existing.rows[0]!;
    const valid = current.rolcanlogin && !current.rolsuper && !current.rolcreatedb
      && !current.rolcreaterole && !current.rolinherit && !current.rolbypassrls;
    if (!valid) throw new Error(`Existing role ${role} has privileges outside the phase 0 contract`);
    return;
  }

  await client.query(
    `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`,
  );
}

async function ensureDatabase(client: Client, database: string): Promise<void> {
  const existing = await client.query<{ owner: string }>(
    `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`,
    [database],
  );
  if (existing.rowCount) {
    if (existing.rows[0]?.owner !== 'si_migrate') {
      throw new Error(`Existing database ${database} is not owned by si_migrate; refusing to modify it`);
    }
    return;
  }
  await client.query(`CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier('si_migrate')}`);
}

export async function setupDatabase(): Promise<void> {
  const envPath = resolve(root, '.env');
  createEnvFile(envPath, resolve(root, '.env.example'));
  loadDotEnv({ path: envPath, override: false });

  const admin = new Client(process.env.DATABASE_URL_ADMIN
    ? { connectionString: process.env.DATABASE_URL_ADMIN }
    : {
        host: process.env.PGHOST || '/tmp',
        port: Number(process.env.PGPORT || 5432),
        user: process.env.USER || process.env.LOGNAME,
        database: 'postgres',
      });

  await admin.connect();
  try {
    const identity = await admin.query<{ current_user: string; rolsuper: boolean }>(
      `SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    if (!identity.rows[0]?.rolsuper) {
      throw new Error('pnpm db:setup requires the local PostgreSQL superuser; connect as the macOS account that owns the Homebrew service');
    }

    const passwords = new Map([
      ['si_migrate', readRolePassword(process.env.DATABASE_URL_MIGRATE, 'si_migrate')],
      ['si_app', readRolePassword(process.env.DATABASE_URL, 'si_app')],
      ['si_worker', readRolePassword(process.env.DATABASE_URL_WORKER, 'si_worker')],
    ]);
    for (const role of roleNames) await ensureRole(admin, role, passwords.get(role)!);

    for (const database of databaseNames) {
      await ensureDatabase(admin, database);
      await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${roleNames.map(quoteIdentifier).join(', ')}`,
      );
    }
  } finally {
    await admin.end();
  }

  console.log('Scale Insyght databases and runtime roles are ready.');
  console.log('Development data: scale_insyght. Integration and contract tests: si_test.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupDatabase().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Database setup failed: ${reason}`);
    process.exitCode = 1;
  });
}

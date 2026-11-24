import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { config } from 'dotenv';
import { Client } from 'pg';

config({ path: resolve('.env') });
const databaseName = 'si_testbed_pg';
const readerRole = 'si_testbed_reader';
const configuredAdmin = process.env.DATABASE_URL_ADMIN;
const adminUrl = configuredAdmin ? new URL(configuredAdmin) : new URL(process.env.DATABASE_URL_MIGRATE ?? 'postgresql://127.0.0.1/postgres');
if (!configuredAdmin) {
  adminUrl.pathname = '/postgres';
  adminUrl.username = userInfo().username;
  adminUrl.password = '';
  adminUrl.search = '';
}
const admin = new Client({ connectionString: adminUrl.toString() });
const password = randomBytes(32).toString('base64url');
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
function saveEnvValue(key: string, value: string): void {
  const path = resolve('.env');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index < 0) lines.push(`${key}=${value}`);
  else lines[index] = `${key}=${value}`;
  writeFileSync(path, `${lines.filter((line, lineIndex) => line || lineIndex < lines.length - 1).join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

try {
  await admin.connect();
  const current = await admin.query<{ current_user: string; rolsuper: boolean }>(`SELECT current_user, rolsuper FROM pg_roles WHERE rolname=current_user`);
  if (!current.rows[0]?.rolsuper) throw new Error('testbed:up requires a local PostgreSQL superuser; set DATABASE_URL_ADMIN in .env to a local administrator connection.');
  const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [readerRole]);
  if (role.rowCount) {
    await admin.query(`ALTER ROLE ${readerRole} WITH LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  } else {
    await admin.query(`CREATE ROLE ${readerRole} WITH LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  }
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${identifier(databaseName)} OWNER ${identifier(current.rows[0]!.current_user)}`);
  await admin.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${identifier(databaseName)} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${identifier(databaseName)} TO ${readerRole}`);
} catch (error) {
  if (error instanceof Error && error.message.includes('testbed:up requires')) throw error;
  throw new Error(`Unable to prepare local PostgreSQL testbed. Confirm PostgreSQL 16 is reachable and this user is a local superuser: ${error instanceof Error ? error.message : 'connection failed'}`);
} finally {
  await admin.end().catch(() => undefined);
}

const sourceUrl = new URL(adminUrl.toString());
sourceUrl.pathname = `/${databaseName}`;
sourceUrl.username = readerRole;
sourceUrl.password = password;
sourceUrl.search = '';
const ownerUrl = new URL(adminUrl.toString());
ownerUrl.pathname = `/${databaseName}`;
const owner = new Client({ connectionString: ownerUrl.toString() });
try {
  await owner.connect();
  await owner.query(readFileSync(resolve('testbed/postgres/schema.sql'), 'utf8'));
  await owner.query(readFileSync(resolve('testbed/postgres/data.sql'), 'utf8'));
  const rowCount = await owner.query<{ total: string }>(`SELECT
    (SELECT count(*) FROM patients) + (SELECT count(*) FROM encounters) +
    (SELECT count(*) FROM orders) + (SELECT count(*) FROM departments) +
    (SELECT count(*) FROM providers) AS total`);
  if (Number(rowCount.rows[0]?.total) < 2_000) throw new Error('The testbed seed did not create the required few thousand rows.');
} finally {
  await owner.end();
}

saveEnvValue('DATABASE_URL_TESTBED', sourceUrl.toString());
process.stdout.write('Local PostgreSQL testbed is ready (2,430 fictional rows; read-only role).\n');

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { config } from 'dotenv';
import { Client } from 'pg';

// K2: a second read-only login for the PostgreSQL testbed that also reads the dbt `analytics` schema (staging views and
// marts), as a warehouse login would. The product's usual testbed login (si_testbed_reader) is not changed, so the
// lineage truth and other walkthroughs keep their catalog; billing stays unreadable for both logins.
// Idempotent; writes DATABASE_URL_TESTBED_WAREHOUSE to .env. Run as the local superuser that owns the testbed.
config({ path: resolve('.env') });
const role = 'si_testbed_dw_reader';
const database = 'si_testbed_pg';
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

function saveEnvValue(key: string, value: string): void {
  const path = resolve('.env');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const match = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (match >= 0) lines[match] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  writeFileSync(path, `${lines.filter((entry, index) => entry || index < lines.length - 1).join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

const existing = process.env.DATABASE_URL_TESTBED_WAREHOUSE ? new URL(process.env.DATABASE_URL_TESTBED_WAREHOUSE) : null;
const password = existing && decodeURIComponent(existing.username) === role ? decodeURIComponent(existing.password) : randomBytes(32).toString('base64url');
const ownerUrl = process.env.DATABASE_URL_ADMIN ? new URL(process.env.DATABASE_URL_ADMIN) : new URL(`postgresql://${userInfo().username}@127.0.0.1:5432/postgres`);
ownerUrl.pathname = `/${database}`;
const owner = new Client({ connectionString: ownerUrl.toString() });
await owner.connect();
try {
  const found = await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
  await owner.query(`${found.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
  await owner.query(`GRANT CONNECT ON DATABASE ${database} TO ${role};
    GRANT USAGE ON SCHEMA public, analytics TO ${role};
    GRANT SELECT ON ALL TABLES IN SCHEMA public, analytics TO ${role};
    ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO ${role};
    REVOKE ALL ON SCHEMA billing FROM ${role};`);
} finally { await owner.end(); }
const url = new URL(`postgresql://127.0.0.1:${ownerUrl.port || 5432}/${database}`);
url.username = role; url.password = password;
saveEnvValue('DATABASE_URL_TESTBED_WAREHOUSE', url.toString());
process.stdout.write(`${role} reads public and analytics in ${database}; DATABASE_URL_TESTBED_WAREHOUSE saved to .env\n`);

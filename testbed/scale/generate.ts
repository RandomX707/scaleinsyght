import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { config } from 'dotenv';
import { Client } from 'pg';

// Scale testbed: a synthetic PostgreSQL catalog of 5,000 tables (structure only, a few rows each) in its own database,
// si_scale_pg, with its own read-only login. 50 schemas (business domains) × 100 tables. In each schema, 5 lookup tables
// (region, category, team, site, channel) and 19 entities in 5 variants each (customer_order, customer_order_line,
// customer_order_history, customer_order_audit, customer_order_snapshot, ...), so names overlap heavily within and across schemas, as in a large warehouse.
// Every non-lookup table has a declared foreign key to one lookup. Rows are deterministic, so testbed/scale/truth.json
// can be recomputed. Idempotent: drops and recreates si_scale_pg. Writes DATABASE_URL_SCALE to .env.
config({ path: resolve('.env') });
export const DOMAINS = ['accounting', 'advertising', 'aftersales', 'audit', 'billing', 'branding', 'budgeting', 'catering', 'claims', 'compliance',
  'construction', 'consulting', 'contracts', 'customs', 'delivery', 'distribution', 'education', 'energy', 'engineering', 'events',
  'facilities', 'finance', 'fleet', 'fundraising', 'grants', 'hospitality', 'insurance', 'inventory', 'investments', 'leasing',
  'legal', 'licensing', 'logistics', 'maintenance', 'manufacturing', 'marketing', 'membership', 'payroll', 'procurement', 'publishing',
  'purchasing', 'quality', 'recruiting', 'research', 'retail', 'sales', 'security', 'support', 'training', 'warehousing'];
export const LOOKUPS = ['region', 'category', 'team', 'site', 'channel'];
export const ENTITIES = ['customer_order', 'shipment', 'invoice', 'ticket', 'vendor', 'employee', 'campaign', 'item', 'inspection', 'work_order',
  'contract', 'payment', 'refund', 'lead', 'account', 'asset', 'request', 'booking', 'review'];
export const VARIANTS = ['', '_line', '_history', '_audit', '_snapshot'];
export const STATUSES = ['open', 'pending', 'closed'];

export function tablesOf(domainIndex: number): Array<{ name: string; lookup: string | null; rows: number }> {
  const tables: Array<{ name: string; lookup: string | null; rows: number }> = LOOKUPS.map((name, index) => ({ name, lookup: null, rows: 3 + ((domainIndex + index) % 4) }));
  ENTITIES.forEach((entity, entityIndex) => VARIANTS.forEach((variant, variantIndex) => {
    const seed = domainIndex * 131 + entityIndex * 17 + variantIndex * 7;
    tables.push({ name: `${entity}${variant}`, lookup: LOOKUPS[seed % LOOKUPS.length]!, rows: 2 + (seed % 7) });
  }));
  return tables;
}
/** Row r (1-based) of a table: its status, created date and lookup id, all deterministic. */
export function row(seed: number, r: number, lookupRows: number) {
  return { status: STATUSES[(seed + r) % 3]!, created: new Date(Date.UTC(2024, 0, 1) + ((seed * 37 + r * 101) % 900) * 86_400_000).toISOString().slice(0, 10), lookupId: 1 + ((seed + r) % lookupRows) };
}

function saveEnvValue(key: string, value: string): void {
  const path = resolve('.env');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const match = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (match >= 0) lines[match] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  writeFileSync(path, `${lines.filter((entry, index) => entry || index < lines.length - 1).join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = 'si_scale_pg'; const role = 'si_scale_reader';
  const adminUrl = process.env.DATABASE_URL_ADMIN ? new URL(process.env.DATABASE_URL_ADMIN) : new URL(`postgresql://${userInfo().username}@127.0.0.1:5432/postgres`);
  const existing = process.env.DATABASE_URL_SCALE ? new URL(process.env.DATABASE_URL_SCALE) : null;
  const password = existing ? decodeURIComponent(existing.password) : randomBytes(32).toString('base64url');
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [database]);
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`CREATE DATABASE ${database}`);
    const found = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    await admin.query(`${found.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${password.replaceAll("'", "''")}'`);
    await admin.query(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  } finally { await admin.end(); }
  const ownerUrl = new URL(adminUrl); ownerUrl.pathname = `/${database}`;
  const owner = new Client({ connectionString: ownerUrl.toString() });
  await owner.connect();
  const started = Date.now();
  try {
    // One transaction per schema: 5,000 tables in one transaction would exceed the server's lock table.
    for (const [domainIndex, domain] of DOMAINS.entries()) {
      const statements: string[] = [`CREATE SCHEMA ${domain}`];
      const tables = tablesOf(domainIndex);
      for (const [tableIndex, table] of tables.entries()) {
        const seed = domainIndex * 1000 + tableIndex;
        const lookupRows = table.lookup ? tables.find((item) => item.name === table.lookup)!.rows : 0;
        statements.push(table.lookup
          ? `CREATE TABLE ${domain}.${table.name} (${table.name}_id integer PRIMARY KEY, code text NOT NULL, status text NOT NULL, created_on date NOT NULL, ${table.lookup}_id integer NOT NULL REFERENCES ${domain}.${table.lookup})`
          : `CREATE TABLE ${domain}.${table.name} (${table.name}_id integer PRIMARY KEY, ${table.name}_name text NOT NULL)`);
        const values = Array.from({ length: table.rows }, (_, index) => {
          const r = index + 1; const value = row(seed, r, lookupRows || 1);
          return table.lookup ? `(${r},'${domain.slice(0, 3).toUpperCase()}-${r}','${value.status}','${value.created}',${value.lookupId})` : `(${r},'${domain} ${table.name} ${r}')`;
        });
        statements.push(`INSERT INTO ${domain}.${table.name} VALUES ${values.join(',')}`);
      }
      statements.push(`GRANT USAGE ON SCHEMA ${domain} TO ${role}`, `GRANT SELECT ON ALL TABLES IN SCHEMA ${domain} TO ${role}`);
      await owner.query(`BEGIN;\n${statements.join(';\n')};\nCOMMIT`);
    }
    await owner.query('ANALYZE');
  } finally { await owner.end(); }
  const url = new URL(`postgresql://127.0.0.1:${adminUrl.port || 5432}/${database}`); url.username = role; url.password = password;
  saveEnvValue('DATABASE_URL_SCALE', url.toString());
  process.stdout.write(`${database}: ${DOMAINS.length} schemas, ${DOMAINS.length * 100} tables in ${((Date.now() - started) / 1000).toFixed(1)} s; DATABASE_URL_SCALE saved to .env\n`);
}

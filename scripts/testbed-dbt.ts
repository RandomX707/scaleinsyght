import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { config } from 'dotenv';
import { Client } from 'pg';

// Builds the testbed dbt project (testbed/dbt) into the PostgreSQL testbed and writes manifest.json and catalog.json
// to testbed/dbt/target for upload through the product. Runs as the local superuser that owns the testbed. The product's
// read-only role sees neither the analytics schema nor the billing schema.
config({ path: resolve('.env') });
const configured = process.env.DATABASE_URL_ADMIN;
const ownerUrl = configured ? new URL(configured) : new URL('postgresql://127.0.0.1:5432/postgres');
if (!configured) { ownerUrl.username = userInfo().username; ownerUrl.password = ''; }
ownerUrl.pathname = '/si_testbed_pg';
// --docs-only regenerates manifest.json and catalog.json from the existing build with `dbt docs generate`, which only
// reads the database: no schema is dropped, rebuilt or re-granted, so other users of the shared testbed are unaffected.
const docsOnly = process.argv.includes('--docs-only');
const owner = new Client({ connectionString: ownerUrl.toString() });
if (!docsOnly) {
await owner.connect();
try {
  await owner.query(`CREATE SCHEMA IF NOT EXISTS billing;
    DROP TABLE IF EXISTS billing.claims;
    CREATE TABLE billing.claims AS SELECT order_id, round(amount * 0.8, 2)::numeric(9,2) AS claim_amount FROM public.orders WHERE order_id % 3 = 0;
    REVOKE ALL ON SCHEMA billing FROM PUBLIC;
    CREATE SCHEMA IF NOT EXISTS analytics;
    REVOKE ALL ON SCHEMA analytics FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA analytics REVOKE SELECT ON TABLES FROM si_testbed_reader;`);
} finally { await owner.end(); }
}
const profilesDir = resolve('.local/dbt/testbed-profiles');
mkdirSync(profilesDir, { recursive: true });
writeFileSync(resolve(profilesDir, 'profiles.yml'), ['testbed_hospital:', '  target: local', '  outputs:', '    local:', '      type: postgres',
  `      host: ${ownerUrl.hostname}`, `      port: ${ownerUrl.port || 5432}`, `      user: ${decodeURIComponent(ownerUrl.username)}`,
  `      password: '${decodeURIComponent(ownerUrl.password).replaceAll("'", "''")}'`, '      dbname: si_testbed_pg', '      schema: analytics', '      threads: 1', ''].join('\n'), { mode: 0o600 });
const dbt = resolve('.venv', 'bin', 'dbt');
const project = resolve('testbed/dbt');
for (const command of docsOnly ? [['docs', 'generate']] : [['run'], ['docs', 'generate']]) {
  execFileSync(dbt, [...command, '--project-dir', project, '--profiles-dir', profilesDir, '--target', 'local'], { stdio: 'inherit', env: { ...process.env, DBT_LOG_PATH: resolve('.local/dbt/testbed-logs') } });
}
// The product's read-only login sees the operational schema only, as a source system would. The dbt models reach the
// graph through the uploaded artifacts (known issue K2 records why the warehouse schema is not exposed to that login).
if (!docsOnly) {
const revoke = new Client({ connectionString: ownerUrl.toString() });
await revoke.connect();
try { await revoke.query('REVOKE ALL ON ALL TABLES IN SCHEMA analytics FROM si_testbed_reader; REVOKE ALL ON SCHEMA analytics FROM si_testbed_reader'); } finally { await revoke.end(); }
}
process.stdout.write(`dbt artifacts: ${resolve(project, 'target/manifest.json')} and catalog.json\n`);

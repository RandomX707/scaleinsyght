import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { config } from 'dotenv';
import { Client } from 'pg';

// Builds the testbed dbt project (testbed/dbt) into the PostgreSQL testbed and writes manifest.json and catalog.json
// to testbed/dbt/target for upload through the product. Runs as the local superuser that owns the testbed; the product's
// read-only role gains SELECT on the analytics schema only. The billing schema stays invisible to it on purpose.
config({ path: resolve('.env') });
const configured = process.env.DATABASE_URL_ADMIN;
const ownerUrl = configured ? new URL(configured) : new URL('postgresql://127.0.0.1:5432/postgres');
if (!configured) { ownerUrl.username = userInfo().username; ownerUrl.password = ''; }
ownerUrl.pathname = '/si_testbed_pg';
const owner = new Client({ connectionString: ownerUrl.toString() });
await owner.connect();
try {
  await owner.query(`CREATE SCHEMA IF NOT EXISTS billing;
    DROP TABLE IF EXISTS billing.claims;
    CREATE TABLE billing.claims AS SELECT order_id, round(amount * 0.8, 2)::numeric(9,2) AS claim_amount FROM public.orders WHERE order_id % 3 = 0;
    REVOKE ALL ON SCHEMA billing FROM PUBLIC;
    CREATE SCHEMA IF NOT EXISTS analytics;
    GRANT USAGE ON SCHEMA analytics TO si_testbed_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO si_testbed_reader;`);
} finally { await owner.end(); }
const profilesDir = resolve('.local/dbt/testbed-profiles');
mkdirSync(profilesDir, { recursive: true });
writeFileSync(resolve(profilesDir, 'profiles.yml'), ['testbed_hospital:', '  target: local', '  outputs:', '    local:', '      type: postgres',
  `      host: ${ownerUrl.hostname}`, `      port: ${ownerUrl.port || 5432}`, `      user: ${decodeURIComponent(ownerUrl.username)}`,
  `      password: '${decodeURIComponent(ownerUrl.password).replaceAll("'", "''")}'`, '      dbname: si_testbed_pg', '      schema: analytics', '      threads: 1', ''].join('\n'), { mode: 0o600 });
const dbt = resolve('.venv', 'bin', 'dbt');
const project = resolve('testbed/dbt');
for (const command of [['run'], ['docs', 'generate']]) {
  execFileSync(dbt, [...command, '--project-dir', project, '--profiles-dir', profilesDir, '--target', 'local'], { stdio: 'inherit', env: { ...process.env, DBT_LOG_PATH: resolve('.local/dbt/testbed-logs') } });
}
const grant = new Client({ connectionString: ownerUrl.toString() });
await grant.connect();
try { await grant.query('GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO si_testbed_reader'); } finally { await grant.end(); }
process.stdout.write(`dbt artifacts: ${resolve(project, 'target/manifest.json')} and catalog.json\n`);

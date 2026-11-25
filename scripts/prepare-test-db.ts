import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';

config({ path: resolve(process.cwd(), '.env'), override: true });

// SI_TEST_DATABASE lets parallel worktrees use separate test databases (default si_test).
// Only names starting with si_test are accepted, so this script can never drop another database.
const testDatabase = process.env.SI_TEST_DATABASE ?? 'si_test';
if (!/^si_test(_[a-z0-9]+)*$/.test(testDatabase) || testDatabase.startsWith('si_testbed')) {
  throw new Error(`SI_TEST_DATABASE must be si_test or si_test_<suffix>; got ${testDatabase}`);
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to prepare the real PostgreSQL contract-test database');
}

const admin = new Client(process.env.DATABASE_URL_ADMIN
  ? { connectionString: process.env.DATABASE_URL_ADMIN }
  : {
      host: process.env.PGHOST || '/tmp',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.USER || process.env.LOGNAME,
      database: 'postgres',
    });

try {
  await admin.connect();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(`PostgreSQL is unreachable; check DATABASE_URL and local PostgreSQL availability. ${reason}`);
}

try {
  const state = await admin.query<{ owner: string }>(
    `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`,
    [testDatabase],
  );
  if (state.rowCount && state.rows[0]?.owner !== 'si_migrate') {
    throw new Error(`Refusing to reset ${testDatabase} because si_migrate does not own it`);
  }
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [testDatabase]);
  if (state.rowCount) await admin.query(`DROP DATABASE ${testDatabase}`);
  await admin.query(`CREATE DATABASE ${testDatabase} OWNER si_migrate`);
  await admin.query(`REVOKE CONNECT ON DATABASE ${testDatabase} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${testDatabase} TO si_migrate, si_app, si_worker`);
  console.log(`Reset only ${testDatabase}; development database scale_insyght was not touched.`);
} finally {
  await admin.end();
}

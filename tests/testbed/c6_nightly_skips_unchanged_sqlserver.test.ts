import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { activateConnection } from '@scaleinsyght/registry';
import { createSqlServerConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { createTenant } from '../../scripts/tenant-create.js';
import { runSqlServerAdminQuery } from '../../testbed/sqlserver/admin-query.js';

// K11 on SQL Server: each nightly run uses a new connector (as a new worker would), and unchanged tables are skipped
// from the signature stored by the last run; a table that gained rows, changed shape or got a sensitivity label is
// profiled again, and views are always profiled. Generic fixture in its own database (si_testbed_nightly).
config({ path: resolve('.env') });
if (!process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('SQLSERVER_TESTBED_PASSWORD is required; run pnpm testbed:sqlserver:up. Never skipped.');
const database = 'si_testbed_nightly';
const reader = process.env.SQLSERVER_TESTBED_USERNAME || 'si_testbed_reader';
const url = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`${key} is required`); const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString(); };
const app = new Pool({ connectionString: url('DATABASE_URL') }); const migrate = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const fresh = () => createSqlServerConnector({ server: process.env.SQLSERVER_TESTBED_HOST ?? 'localhost', port: Number(process.env.SQLSERVER_TESTBED_PORT ?? 1433), database,
  username: reader, password: process.env.SQLSERVER_TESTBED_PASSWORD, encrypt: true, trustServerCertificate: true });
const tenantId = `nightly-sql-${randomUUID()}`;
let connectionId = '';
async function run(jobType: 'profile' | 'nightly') {
  const connector = fresh();
  try { return await runProfile(app, { tenantId, connectionId, connector, jobType }); } finally { await connector.close?.(); }
}

describe('SQL Server nightly refresh skips unchanged tables in a fresh worker (K11)', () => {
  beforeAll(async () => {
    runSqlServerAdminQuery(`IF DB_ID(N'${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END; CREATE DATABASE [${database}];`, 'master');
    runSqlServerAdminQuery(`CREATE TABLE dbo.Alpha (Id int NOT NULL PRIMARY KEY); CREATE TABLE dbo.Beta (Id int NOT NULL PRIMARY KEY, Note nvarchar(40) NULL); CREATE TABLE dbo.Gamma (Id int NOT NULL PRIMARY KEY);
      INSERT INTO dbo.Alpha VALUES (1),(2); INSERT INTO dbo.Beta VALUES (1, N'a'); INSERT INTO dbo.Gamma VALUES (1),(2),(3);`, database);
    runSqlServerAdminQuery(`CREATE VIEW dbo.AlphaView AS SELECT Id FROM dbo.Alpha;`, database);
    runSqlServerAdminQuery(`CREATE USER [${reader}] FOR LOGIN [${reader}]; ALTER ROLE [db_datareader] ADD MEMBER [${reader}]; GRANT VIEW DEFINITION TO [${reader}];
      DENY INSERT, UPDATE, DELETE, ALTER, REFERENCES, TAKE OWNERSHIP ON DATABASE::[${database}] TO [${reader}];`, database);
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    const { userId } = await createTenant(migrate, { tenantId, name: 'Nightly SQL', displayName: 'Nightly Tester', email: `owner@${tenantId}.test.invalid`, password: 'nightly-sqlserver-password-1' });
    connectionId = (await activateConnection(app, { tenantId, principalId: userId, connectorType: 'sql_server', sourceRef: 'nightly-sqlserver' })).connectionId;
  }, 300_000);
  afterAll(async () => {
    runSqlServerAdminQuery(`IF DB_ID(N'${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END;`, 'master');
    await app.end(); await migrate.end();
  });

  it('c6_sqlserver_unchanged_tables_are_skipped_and_each_kind_of_change_is_profiled_again', async () => {
    expect((await run('profile')).profiled).toBe(4);
    const quiet = await run('nightly');
    expect({ profiled: quiet.profiled, unchanged: quiet.unchanged }).toEqual({ profiled: 1, unchanged: 3 }); // the view is always profiled
    runSqlServerAdminQuery(`INSERT INTO dbo.Alpha VALUES (3); ALTER TABLE dbo.Gamma ADD Extra int NULL;
      EXEC sys.sp_addextendedproperty @name = N'sensitivity', @value = N'personal', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Beta', @level2type = N'COLUMN', @level2name = N'Note';`, database);
    const changed = await run('nightly');
    expect({ profiled: changed.profiled, unchanged: changed.unchanged }).toEqual({ profiled: 4, unchanged: 0 }); // rows, shape and a label
    const again = await run('nightly');
    expect({ profiled: again.profiled, unchanged: again.unchanged }).toEqual({ profiled: 1, unchanged: 3 });
  }, 600_000);
});

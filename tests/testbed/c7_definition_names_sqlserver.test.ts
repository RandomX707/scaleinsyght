import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { activateConnection } from '@scaleinsyght/registry';
import { createSqlServerConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { buildServer } from '@scaleinsyght/api/server';
import { createTenant } from '../../scripts/tenant-create.js';
import { runSqlServerAdminQuery } from '../../testbed/sqlserver/admin-query.js';

// A SQL Server procedure's Reads, Writes and Calls name only objects of the source's catalog: never a CTE, a table
// variable, a temp table or an alias, and a function in FROM or in a select list is a call. Generic fixture in its own
// database (si_testbed_names), created and dropped here so the shared Dictionary testbed is never changed.
config({ path: resolve('.env') });
if (!process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('SQLSERVER_TESTBED_PASSWORD is required; run pnpm testbed:sqlserver:up. Never skipped.');
const database = 'si_testbed_names';
const reader = process.env.SQLSERVER_TESTBED_USERNAME || 'si_testbed_reader';
const url = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`${key} is required`); const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString(); };
const app = new Pool({ connectionString: url('DATABASE_URL') }); const migrate = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const connector = createSqlServerConnector({ server: process.env.SQLSERVER_TESTBED_HOST ?? 'localhost', port: Number(process.env.SQLSERVER_TESTBED_PORT ?? 1433), database,
  username: reader, password: process.env.SQLSERVER_TESTBED_PASSWORD, encrypt: true, trustServerCertificate: true });
const tenantId = `names-sql-${randomUUID()}`; const email = `owner@${tenantId}.test.invalid`; const password = 'names-sqlserver-password-1';
let server: Awaited<ReturnType<typeof buildServer>>; let cookie = ''; let connectionId = '';
const get = async (path: string) => { const response = await server.inject({ method: 'GET', url: path, headers: { cookie } }); expect(response.statusCode, response.body).toBe(200); return response.json(); };
const detail = (name: string) => get(`/api/connections/${connectionId}/dictionary/object?name=${encodeURIComponent(name)}`);

describe('SQL Server definition names resolve against the catalog', () => {
  beforeAll(async () => {
    runSqlServerAdminQuery(`IF DB_ID(N'${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END; CREATE DATABASE [${database}];`, 'master');
    for (const batch of [
      `CREATE TABLE dbo.Customers (CustomerId int NOT NULL PRIMARY KEY, Name nvarchar(80) NOT NULL);
       CREATE TABLE dbo.Orders (OrderId int NOT NULL PRIMARY KEY, CustomerId int NOT NULL, OrderDate date NOT NULL);
       CREATE TABLE dbo.OrderSummary (CustomerId int NOT NULL PRIMARY KEY, Total int NOT NULL, Region nvarchar(20) NULL);`,
      `CREATE FUNCTION dbo.fn_SplitIds (@Ids nvarchar(max)) RETURNS TABLE AS RETURN SELECT CAST(value AS int) AS CustomerId FROM STRING_SPLIT(@Ids, ',');`,
      `CREATE FUNCTION dbo.fn_Region (@CustomerId int) RETURNS nvarchar(20) AS BEGIN RETURN CASE WHEN @CustomerId % 2 = 0 THEN N'East' ELSE N'West' END; END;`,
      `CREATE PROCEDURE dbo.usp_WriteLog @Name nvarchar(80) AS BEGIN SET NOCOUNT ON; END;`,
      `CREATE PROCEDURE dbo.usp_Secret WITH ENCRYPTION AS BEGIN SELECT COUNT(*) FROM dbo.Orders; EXEC dbo.usp_WriteLog @Name = N'secret'; END;`,
      `CREATE PROCEDURE dbo.usp_LoadOrderSummary @Ids nvarchar(max) AS
       BEGIN
         DECLARE @picked TABLE (CustomerId int);
         INSERT INTO @picked (CustomerId) SELECT CustomerId FROM dbo.fn_SplitIds(@Ids);
         SELECT o.OrderId, o.CustomerId INTO #recent FROM dbo.Orders AS o WHERE o.OrderDate > '2025-01-01';
         WITH totals AS (SELECT c.CustomerId, COUNT(*) AS n FROM dbo.Customers c JOIN #recent r ON r.CustomerId = c.CustomerId GROUP BY c.CustomerId)
         MERGE dbo.OrderSummary AS target USING totals AS source ON target.CustomerId = source.CustomerId
           WHEN MATCHED THEN UPDATE SET target.Total = source.n, target.Region = dbo.fn_Region(source.CustomerId)
           WHEN NOT MATCHED THEN INSERT (CustomerId, Total) VALUES (source.CustomerId, source.n);
         SELECT p.CustomerId FROM @picked p JOIN Customers cu ON cu.CustomerId = p.CustomerId;
         EXEC dbo.usp_WriteLog @Name = N'summary';
       END;`,
    ]) runSqlServerAdminQuery(batch, database);
    runSqlServerAdminQuery(`CREATE USER [${reader}] FOR LOGIN [${reader}]; ALTER ROLE [db_datareader] ADD MEMBER [${reader}]; GRANT VIEW DEFINITION TO [${reader}];
      DENY INSERT, UPDATE, DELETE, ALTER, REFERENCES, TAKE OWNERSHIP ON DATABASE::[${database}] TO [${reader}];`, database);
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    const { userId } = await createTenant(migrate, { tenantId, name: 'Names SQL', displayName: 'Names Tester', email, password });
    connectionId = (await activateConnection(app, { tenantId, principalId: userId, connectorType: 'sql_server', sourceRef: 'names-sqlserver' })).connectionId;
    await runProfile(app, { tenantId, connectionId, connector, jobType: 'profile' });
    server = await buildServer({ pool: app, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email }], testConnectorFor: (ref) => ref === 'names-sqlserver' ? connector : null });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
  }, 180_000);
  afterAll(async () => {
    await server?.close(); await connector.close(); await app.end(); await migrate.end();
    runSqlServerAdminQuery(`ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}];`, 'master');
  });

  it('c7_procedure_reads_writes_and_calls_name_only_catalog_objects', async () => {
    const opened = await detail('dbo.usp_LoadOrderSummary');
    expect(opened.definition.reads).toEqual(['dbo.Customers', 'dbo.Orders']);
    expect(opened.definition.writes).toEqual([{ table: 'dbo.OrderSummary', mode: 'merge' }]);
    expect(opened.definition.calls).toEqual(['dbo.fn_Region', 'dbo.fn_SplitIds', 'dbo.usp_WriteLog']);
    expect(opened.definition.unresolved).toEqual([]);
    expect(opened.definition.tablesAndColumns.map((item: { table: string }) => item.table).sort()).toEqual(['dbo.Customers', 'dbo.OrderSummary', 'dbo.Orders']);
    expect((await detail('dbo.fn_Region')).definition.calledBy).toEqual(['dbo.usp_LoadOrderSummary']);
    expect((await detail('dbo.fn_SplitIds')).definition.calledBy).toEqual(['dbo.usp_LoadOrderSummary']);
    expect((await detail('dbo.usp_WriteLog')).definition.calledBy).toEqual(['dbo.usp_LoadOrderSummary', 'dbo.usp_Secret']);
  });

  it('c7_an_encrypted_procedure_shows_what_the_catalog_records_it_refers_to', async () => {
    const secret = await detail('dbo.usp_Secret');
    expect(secret.definition).toMatchObject({ encrypted: true, text: null, reads: [], writes: [], uses: ['dbo.Orders'], calls: ['dbo.usp_WriteLog'], usesFromCatalog: true });
    expect(secret.description.text).toBe('Procedure whose SQL the source encrypts. The database catalog records that it refers to Orders and runs usp_WriteLog, but not whether it reads or writes them.');
    const orders = await detail('dbo.Orders');
    expect(orders.usedBy).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'dbo.usp_Secret', how: 'refers to it (database catalog; the module is encrypted)' })]));
  });
});

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from 'dotenv';
import { SQLSERVER_TESTBED_CONTAINER, runSqlServerAdminQuery } from './admin-query.js';

config({ path: resolve('.env') });
const databaseName = 'si_testbed_sqlserver';
const host = process.env.SQLSERVER_TESTBED_HOST || '127.0.0.1';
const port = Number(process.env.SQLSERVER_TESTBED_PORT || 1433);
const readerName = process.env.SQLSERVER_TESTBED_USERNAME || 'si_testbed_reader';
const readerPassword = process.env.SQLSERVER_TESTBED_PASSWORD || `Aa1!${randomBytes(32).toString('base64url')}`;
const adminPassword = process.env.SQLSERVER_TESTBED_ADMIN_PASSWORD || `Aa1!${randomBytes(32).toString('base64url')}`;

function saveEnvValue(key: string, value: string): void {
  const path = resolve('.env');
  if (!existsSync(path)) throw new Error('.env is required; copy .env.example first.');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index < 0) lines.push(`${key}=${value}`);
  else lines[index] = `${key}=${value}`;
  writeFileSync(path, `${lines.filter((line, lineIndex) => line || lineIndex < lines.length - 1).join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  process.env[key] = value;
}

function docker(args: string[], quiet = false): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const reason = quiet ? 'sqlserver_testbed_container_not_ready' : `sqlserver_testbed_docker_${args[0] ?? 'command'}_failed`;
    throw new Error(reason);
  }
  return result.stdout.trim();
}

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function sqlLiteral(value: string): string {
  return `N'${value.replaceAll("'", "''")}'`;
}

const info = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { encoding: 'utf8' });
if (info.error || info.status !== 0 || info.stdout.trim() !== 'linux') {
  throw new Error('SQL Server testbed requires Colima with the Docker runtime. Start it with: colima start --vm-type=vz --vz-rosetta');
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(readerName)) {
  throw new Error('sqlserver_testbed_configuration_invalid');
}

saveEnvValue('SQLSERVER_TESTBED_HOST', host);
saveEnvValue('SQLSERVER_TESTBED_PORT', String(port));
saveEnvValue('SQLSERVER_TESTBED_DATABASE', databaseName);
saveEnvValue('SQLSERVER_TESTBED_USERNAME', readerName);
saveEnvValue('SQLSERVER_TESTBED_PASSWORD', readerPassword);
saveEnvValue('SQLSERVER_TESTBED_ADMIN_PASSWORD', adminPassword);
mkdirSync(resolve('.local'), { recursive: true, mode: 0o700 });
const adminEnvPath = resolve('.local/sqlserver-admin.env');
writeFileSync(adminEnvPath, `MSSQL_SA_PASSWORD=${adminPassword}\n`, { mode: 0o600 });

const existing = spawnSync('docker', ['inspect', SQLSERVER_TESTBED_CONTAINER], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
if (existing.status === 0) docker(['rm', '-f', SQLSERVER_TESTBED_CONTAINER]);
docker(['volume', 'create', 'si_testbed_sqlserver_data']);
docker([
  'run', '--detach', '--platform', 'linux/amd64', '--name', SQLSERVER_TESTBED_CONTAINER,
  '--memory=4g', '--restart=unless-stopped', '--env-file', adminEnvPath,
  '-e', 'ACCEPT_EULA=Y', '-e', 'MSSQL_PID=Developer', '-p', `${host}:${port}:1433`,
  '-v', 'si_testbed_sqlserver_data:/var/opt/mssql', 'mcr.microsoft.com/mssql/server:2022-latest',
]);

let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    runSqlServerAdminQuery('SET NOCOUNT ON; SELECT 1;');
    ready = true;
    break;
  } catch {
    wait(2_000);
  }
}
if (!ready) throw new Error('SQL Server 2022 did not become ready in Colima; inspect `docker logs si_testbed_sqlserver`.');

runSqlServerAdminQuery(`
IF DB_ID(N'${databaseName}') IS NOT NULL
BEGIN
  ALTER DATABASE [${databaseName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE [${databaseName}];
END;
CREATE DATABASE [${databaseName}];
`, 'master');
runSqlServerAdminQuery(readFileSync(resolve('testbed/sqlserver/schema.sql'), 'utf8'), databaseName);
runSqlServerAdminQuery(readFileSync(resolve('testbed/sqlserver/data.sql'), 'utf8'), databaseName);
runSqlServerAdminQuery(`
USE [master];
IF SUSER_ID(N'${readerName}') IS NULL
  CREATE LOGIN [${readerName}] WITH PASSWORD=${sqlLiteral(readerPassword)}, CHECK_POLICY=OFF, CHECK_EXPIRATION=OFF;
ELSE
  ALTER LOGIN [${readerName}] WITH PASSWORD=${sqlLiteral(readerPassword)}, CHECK_POLICY=OFF, CHECK_EXPIRATION=OFF;
GO
USE [${databaseName}];
IF USER_ID(N'${readerName}') IS NOT NULL DROP USER [${readerName}];
CREATE USER [${readerName}] FOR LOGIN [${readerName}];
ALTER ROLE [db_datareader] ADD MEMBER [${readerName}];
GRANT VIEW DEFINITION TO [${readerName}];
DENY INSERT, UPDATE, DELETE, ALTER, CONTROL, REFERENCES, TAKE OWNERSHIP ON DATABASE::[${databaseName}] TO [${readerName}];
`);
const total = runSqlServerAdminQuery(`SET NOCOUNT ON; SELECT COUNT_BIG(*) FROM (
  SELECT patient_id AS id FROM dbo.patients UNION ALL SELECT encounter_id FROM dbo.encounters
  UNION ALL SELECT order_id FROM dbo.orders UNION ALL SELECT department_id FROM dbo.departments
  UNION ALL SELECT provider_id FROM dbo.providers
) rows;`, databaseName);
if (Number(total.split(/\r?\n/).at(-1)) < 2_000) throw new Error('sqlserver_testbed_seed_below_minimum');
process.stdout.write('Local SQL Server 2022 testbed is ready (2,430 fictional rows; SELECT-only login).\n');

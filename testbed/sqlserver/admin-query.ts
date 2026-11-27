import { spawnSync } from 'node:child_process';

export const SQLSERVER_TESTBED_CONTAINER = 'si_testbed_sqlserver';

export function runSqlServerAdminQuery(sql: string, database = 'master'): string {
  if (!['master', 'si_testbed_sqlserver', 'si_testbed_dictionary', 'si_testbed_names', 'si_testbed_nightly'].includes(database)) throw new Error('sqlserver_testbed_database_invalid');
  const command = [
    'tool="/opt/mssql-tools18/bin/sqlcmd"; [ -x "$tool" ] || tool="/opt/mssql-tools/bin/sqlcmd"; export SQLCMDPASSWORD="$MSSQL_SA_PASSWORD"; exec "$tool" -S localhost -U sa -C -b -d "' + database + '" -h -1 -W -w 65535',
  ][0]!;
  const result = spawnSync('docker', ['exec', '-i', SQLSERVER_TESTBED_CONTAINER, 'bash', '-lc', command], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('sqlserver_testbed_query_failed');
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');
}

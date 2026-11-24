import { randomBytes } from 'node:crypto';
import { runSqlServerAdminQuery } from '../../testbed/sqlserver/admin-query.js';

export function createDisposableSqlServerWriter() {
  const username = 'si_test_writer_' + randomBytes(10).toString('hex');
  const password = randomBytes(24).toString('hex') + 'Aa9!';
  const database = 'si_testbed_sqlserver';
  runSqlServerAdminQuery(`CREATE LOGIN [${username}] WITH PASSWORD = '${password}', CHECK_POLICY = OFF;`);
  try {
    runSqlServerAdminQuery(`CREATE USER [${username}] FOR LOGIN [${username}];
      ALTER ROLE [db_datareader] ADD MEMBER [${username}];
      ALTER ROLE [db_datawriter] ADD MEMBER [${username}];`, database);
  } catch (error) {
    runSqlServerAdminQuery(`IF USER_ID('${username}') IS NOT NULL DROP USER [${username}];`, database);
    runSqlServerAdminQuery(`DROP LOGIN [${username}];`);
    throw error;
  }
  return {username,password,remove() {
    runSqlServerAdminQuery(`DROP USER [${username}];`, database);
    runSqlServerAdminQuery(`DROP LOGIN [${username}];`);
  }};
}

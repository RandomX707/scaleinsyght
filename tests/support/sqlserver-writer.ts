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
    runSqlServerAdminQuery(`ALTER LOGIN [${username}] DISABLE;
      DECLARE @session int, @command nvarchar(30);
      DECLARE writer_sessions CURSOR LOCAL FAST_FORWARD FOR
        SELECT session_id FROM sys.dm_exec_sessions WHERE original_login_name = N'${username}';
      OPEN writer_sessions;
      FETCH NEXT FROM writer_sessions INTO @session;
      WHILE @@FETCH_STATUS = 0
      BEGIN
        SET @command = N'KILL ' + CAST(@session AS nvarchar(10));
        BEGIN TRY EXEC(@command); END TRY
        BEGIN CATCH IF ERROR_NUMBER() <> 6101 THROW; END CATCH;
        FETCH NEXT FROM writer_sessions INTO @session;
      END;
      CLOSE writer_sessions;
      DEALLOCATE writer_sessions;`);
    runSqlServerAdminQuery(`DROP USER [${username}];`, database);
    runSqlServerAdminQuery(`DROP LOGIN [${username}];`);
  }};
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { runSqlServerAdminQuery } from '../sqlserver/admin-query.js';

// Builds the Dictionary testbed database on the local SQL Server testbed: si_testbed_dictionary, recreated each run.
// The existing read-only testbed login is mapped into it (read and VIEW DEFINITION only); its password is not changed,
// so other testbed sources and tenants are unaffected. Run after pnpm testbed:up.
config({ path: resolve('.env') });
const reader = process.env.SQLSERVER_TESTBED_USERNAME || 'si_testbed_reader';
const database = 'si_testbed_dictionary';
runSqlServerAdminQuery(`IF DB_ID(N'${database}') IS NOT NULL
BEGIN
  ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE [${database}];
END;
CREATE DATABASE [${database}];`, 'master');
for (const batch of readFileSync(resolve('testbed/dictionary/sqlserver.sql'), 'utf8').split(/^GO\s*$/m)) if (batch.trim()) runSqlServerAdminQuery(batch, database);
runSqlServerAdminQuery(`CREATE USER [${reader}] FOR LOGIN [${reader}];
ALTER ROLE [db_datareader] ADD MEMBER [${reader}];
GRANT VIEW DEFINITION TO [${reader}];
DENY INSERT, UPDATE, DELETE, ALTER, REFERENCES, TAKE OWNERSHIP ON DATABASE::[${database}] TO [${reader}];`, database);
process.stdout.write(`${database} ready; ${reader} can read it.\n`);

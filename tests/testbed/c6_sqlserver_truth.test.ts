import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { runSqlServerAdminQuery } from '../../testbed/sqlserver/admin-query.js';

config({ path: '.env' });
if (!process.env.SQLSERVER_TESTBED_PASSWORD) {
  throw new Error('SQLSERVER_TESTBED_PASSWORD is required; run pnpm testbed:sqlserver:up. SQL Server contract tests are never skipped.');
}
const truth = JSON.parse(readFileSync('testbed/truth.json', 'utf8')) as {
  rowCounts: Record<string, number>;
  sqlServer: {
    rowCounts: Record<string, number>;
    columnCounts: Record<string, number>;
    foreignKeys: Array<{ from: string; to: string }>;
    viewNames: string[];
    procedureNames: string[];
    sensitiveColumns: string[];
    inferredRelationship: { from: string; to: string; matches: number; declared: false };
    sharedPatientIds: number;
    sharedEncounterIds: number;
  };
};
const actual = runSqlServerAdminQuery(`
SET NOCOUNT ON;
SELECT 'rowCounts|' + t.name + '|' + CONVERT(varchar(30), CASE t.name
  WHEN 'patients' THEN (SELECT COUNT_BIG(*) FROM dbo.patients)
  WHEN 'encounters' THEN (SELECT COUNT_BIG(*) FROM dbo.encounters)
  WHEN 'orders' THEN (SELECT COUNT_BIG(*) FROM dbo.orders)
  WHEN 'departments' THEN (SELECT COUNT_BIG(*) FROM dbo.departments)
  ELSE (SELECT COUNT_BIG(*) FROM dbo.providers) END)
FROM (VALUES ('patients'),('encounters'),('orders'),('departments'),('providers')) t(name)
UNION ALL SELECT 'foreignKeys|' + pt.name + '.' + pc.name + '|' + rt.name + '.' + rc.name
FROM sys.foreign_key_columns fkc JOIN sys.tables pt ON pt.object_id=fkc.parent_object_id
JOIN sys.columns pc ON pc.object_id=fkc.parent_object_id AND pc.column_id=fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id=fkc.referenced_object_id
JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id;
`, 'si_testbed_sqlserver');

describe('contract 6 real SQL Server testbed metadata', () => {
  it('c6_sqlserver_testbed_data_matches_sql_derived_truth', () => {
    const rowCounts = Object.fromEntries(actual.split(/\r?\n/)
      .filter((line) => line.startsWith('rowCounts|'))
      .map((line) => { const [, table, count] = line.split('|'); return [table, Number(count)]; }));
    expect(rowCounts).toEqual(truth.sqlServer.rowCounts);
    expect(Object.keys(rowCounts).sort()).toEqual(['departments','encounters','orders','patients','providers']);
    const foreignKeys = actual.split(/\r?\n/).filter((line) => line.startsWith('foreignKeys|'))
      .map((line) => { const [, from, to] = line.split('|'); return { from, to }; })
      .sort((left, right) => left.from.localeCompare(right.from));
    expect(foreignKeys).toEqual(truth.sqlServer.foreignKeys);
    expect(truth.sqlServer.viewNames).toEqual(['dbo.department_order_summary','dbo.patient_encounter_summary']);
    expect(truth.sqlServer.procedureNames).toEqual(['dbo.count_patient_encounters','dbo.patient_order_total']);
  });

  it('c6_sqlserver_and_postgres_share_patient_and_encounter_keys_without_persisting_values', () => {
    expect(truth.sqlServer.sharedPatientIds).toBe(truth.rowCounts.patients);
    expect(truth.sqlServer.sharedEncounterIds).toBe(truth.rowCounts.encounters);
    expect(truth.sqlServer.inferredRelationship).toMatchObject({
      from: 'encounters.patient_id', to: 'patients.patient_id', matches: 700, declared: false,
    });
    expect(truth.sqlServer.sensitiveColumns).toEqual(expect.arrayContaining([
      'patients.name','patients.date_of_birth','patients.mrn','patients.phone',
    ]));
  });
});

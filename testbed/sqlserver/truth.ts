import type { Client } from 'pg';
import { runSqlServerAdminQuery } from './admin-query.js';

export type SqlServerTruth = {
  source: string;
  rowCounts: Record<string, number>;
  columnCounts: Record<string, number>;
  foreignKeys: Array<{ from: string; to: string }>;
  viewNames: string[];
  procedureNames: string[];
  sensitiveColumns: string[];
  nullRates: Record<string, number>;
  metrics: Record<string, number>;
  inferredRelationship: { from: string; to: string; matches: number; sourceCount: number; targetCount: number; declared: false };
  sharedPatientIds: number;
  sharedEncounterIds: number;
  answerMetrics: {
    emergencyVisits2025: number;
    ordersPerDepartmentTop5: Array<{ departmentId: number; departmentName: string; orderCount: number }>;
    averageEncountersPerPatientByProvider: Array<{ providerId: number; average: number }>;
  };
};

const truthQuery = `
SET NOCOUNT ON;
SELECT 'rowCounts|patients|' + CONVERT(varchar(30),COUNT_BIG(*)) FROM dbo.patients
UNION ALL SELECT 'rowCounts|encounters|' + CONVERT(varchar(30),COUNT_BIG(*)) FROM dbo.encounters
UNION ALL SELECT 'rowCounts|orders|' + CONVERT(varchar(30),COUNT_BIG(*)) FROM dbo.orders
UNION ALL SELECT 'rowCounts|departments|' + CONVERT(varchar(30),COUNT_BIG(*)) FROM dbo.departments
UNION ALL SELECT 'rowCounts|providers|' + CONVERT(varchar(30),COUNT_BIG(*)) FROM dbo.providers
UNION ALL SELECT 'columnCounts|' + table_name + '|' + CONVERT(varchar(30),COUNT_BIG(*)) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='dbo' AND table_name IN ('patients','encounters','orders','departments','providers') GROUP BY table_name
UNION ALL SELECT 'foreignKeys|' + parent_table.name + '.' + parent_column.name + '|' + referenced_table.name + '.' + referenced_column.name
  FROM sys.foreign_key_columns fkc
  JOIN sys.tables parent_table ON parent_table.object_id=fkc.parent_object_id
  JOIN sys.columns parent_column ON parent_column.object_id=fkc.parent_object_id AND parent_column.column_id=fkc.parent_column_id
  JOIN sys.tables referenced_table ON referenced_table.object_id=fkc.referenced_object_id
  JOIN sys.columns referenced_column ON referenced_column.object_id=fkc.referenced_object_id AND referenced_column.column_id=fkc.referenced_column_id
UNION ALL SELECT 'viewNames|dbo.' + name FROM sys.views WHERE schema_id=SCHEMA_ID('dbo')
UNION ALL SELECT 'procedureNames|dbo.' + name FROM sys.procedures WHERE schema_id=SCHEMA_ID('dbo')
UNION ALL SELECT 'sensitiveColumns|' + t.name + '.' + c.name + '|' + CONVERT(varchar(100),ep.value)
  FROM sys.extended_properties ep JOIN sys.tables t ON t.object_id=ep.major_id
  JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=ep.minor_id
  WHERE ep.class=1 AND ep.name='sensitivity' AND t.schema_id=SCHEMA_ID('dbo')
UNION ALL SELECT 'nullRates|patients.phone|' + CONVERT(varchar(40),CONVERT(decimal(18,10),SUM(CASE WHEN phone IS NULL THEN 1 ELSE 0 END)*1.0/NULLIF(COUNT_BIG(*),0))) FROM dbo.patients
UNION ALL SELECT 'nullRates|encounters.discharged_at|' + CONVERT(varchar(40),CONVERT(decimal(18,10),SUM(CASE WHEN discharged_at IS NULL THEN 1 ELSE 0 END)*1.0/NULLIF(COUNT_BIG(*),0))) FROM dbo.encounters
UNION ALL SELECT 'metrics|patients|' + CONVERT(varchar(40),COUNT_BIG(*)) FROM dbo.patients
UNION ALL SELECT 'metrics|encounters|' + CONVERT(varchar(40),COUNT_BIG(*)) FROM dbo.encounters
UNION ALL SELECT 'metrics|orders|' + CONVERT(varchar(40),COUNT_BIG(*)) FROM dbo.orders
UNION ALL SELECT 'metrics|completed_orders|' + CONVERT(varchar(40),COUNT_BIG(*)) FROM dbo.orders WHERE order_status=N'completed'
UNION ALL SELECT 'metrics|order_amount|' + CONVERT(varchar(40),COALESCE(SUM(amount),0)) FROM dbo.orders
UNION ALL SELECT 'metrics|encounter_per_patient|' + CONVERT(varchar(40),AVG(n*1.0)) FROM (SELECT COUNT_BIG(*) AS n FROM dbo.encounters GROUP BY patient_id) e
UNION ALL SELECT 'metrics|orders_department_' + CONVERT(varchar(10),department_id) + '|' + CONVERT(varchar(40),COUNT_BIG(*)) FROM dbo.orders GROUP BY department_id
UNION ALL SELECT 'inferredRelationship|count|' + CONVERT(varchar(30),COUNT_BIG(*)) + '|' + CONVERT(varchar(30),COUNT_BIG(DISTINCT e.patient_id)) + '|' + CONVERT(varchar(30),(SELECT COUNT_BIG(DISTINCT patient_id) FROM dbo.patients))
  FROM dbo.encounters e JOIN dbo.patients p ON p.patient_id=e.patient_id;
`;

function parseMetricLines(output: string): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const pieces = line.split('|');
    const key = pieces.shift();
    if (key) parsed.set(`${key}|${pieces.shift() ?? ''}`, pieces);
  }
  return parsed;
}

function numericMap(parsed: Map<string, string[]>, key: string): Record<string, number> {
  return Object.fromEntries([...parsed.entries()]
    .filter(([entry]) => entry.startsWith(`${key}|`))
    .map(([entry, value]) => [entry.slice(key.length + 1), Number(value[0])]));
}

export async function collectSqlServerTruth(postgres: Client): Promise<SqlServerTruth> {
  const parsed = parseMetricLines(runSqlServerAdminQuery(truthQuery, 'si_testbed_sqlserver'));
  const answerLines = runSqlServerAdminQuery(`SET NOCOUNT ON;
SELECT 'emergencyVisits2025|' + CONVERT(varchar(30),COUNT_BIG(*))
FROM dbo.encounters e JOIN dbo.departments d ON d.department_id=e.department_id
WHERE d.department_name=N'Emergency' AND e.admitted_at>='2025-01-01' AND e.admitted_at<'2026-01-01'
UNION ALL SELECT 'ordersPerDepartmentTop5|' + CONVERT(varchar(10),department_id) + '|' + department_name + '|' + CONVERT(varchar(30),order_count)
FROM (SELECT TOP (5) d.department_id,d.department_name,COUNT_BIG(*) AS order_count
  FROM dbo.departments d JOIN dbo.orders o ON o.department_id=d.department_id
  GROUP BY d.department_id,d.department_name ORDER BY COUNT_BIG(*) DESC,d.department_id) top_departments
UNION ALL SELECT 'averageEncountersPerPatientByProvider|' + CONVERT(varchar(10),provider_id) + '|' + CONVERT(varchar(40),AVG(encounter_count*1.0))
FROM (SELECT provider_id,patient_id,COUNT_BIG(*) AS encounter_count FROM dbo.encounters GROUP BY provider_id,patient_id) per_patient
GROUP BY provider_id;`, 'si_testbed_sqlserver');
  const foreignKeys = [...parsed.entries()]
    .filter(([key]) => key.startsWith('foreignKeys|'))
    .map(([key, value]) => ({ from: key.slice('foreignKeys|'.length), to: value[0] ?? '' }))
    .sort((left, right) => left.from.localeCompare(right.from));
  const readNames = async (table: 'patients' | 'encounters', column: 'patient_id' | 'encounter_id') => {
    const result = await postgres.query<{ id: string }>(`SELECT DISTINCT ${column}::text AS id FROM public.${table} ORDER BY id`);
    return new Set(result.rows.map((row) => row.id));
  };
  const [pgPatientIds, pgEncounterIds] = await Promise.all([
    readNames('patients', 'patient_id'),
    readNames('encounters', 'encounter_id'),
  ]);
  const ids = runSqlServerAdminQuery(`SET NOCOUNT ON;
SELECT 'patientId|' + CONVERT(varchar(20),patient_id) FROM dbo.patients ORDER BY patient_id;
SELECT 'encounterId|' + CONVERT(varchar(20),encounter_id) FROM dbo.encounters ORDER BY encounter_id;`, 'si_testbed_sqlserver');
  const patientIds = new Set(ids.split(/\r?\n/).filter((line) => line.startsWith('patientId|')).map((line) => line.slice('patientId|'.length)));
  const encounterIds = new Set(ids.split(/\r?\n/).filter((line) => line.startsWith('encounterId|')).map((line) => line.slice('encounterId|'.length)));
  const sharedCount = (left: Set<string>, right: Set<string>) => [...left].filter((id) => right.has(id)).length;
  const inferred = parsed.get('inferredRelationship|count') ?? [];
  const inferredMatches = Number(inferred[0] ?? 0);
  const inferredSourceCount = Number(inferred[1] ?? 0);
  const inferredTargetCount = Number(inferred[2] ?? 0);
  const answerMetricLines = answerLines.split(/\r?\n/).filter(Boolean);
  const emergencyVisits2025 = Number(answerMetricLines.find((line) => line.startsWith('emergencyVisits2025|'))?.split('|')[1] ?? NaN);
  const ordersPerDepartmentTop5 = answerMetricLines.filter((line) => line.startsWith('ordersPerDepartmentTop5|')).map((line) => {
    const [, departmentId, departmentName, orderCount] = line.split('|');
    return { departmentId: Number(departmentId), departmentName: departmentName ?? '', orderCount: Number(orderCount) };
  });
  const averageEncountersPerPatientByProvider = answerMetricLines.filter((line) => line.startsWith('averageEncountersPerPatientByProvider|')).map((line) => {
    const [, providerId, average] = line.split('|');
    return { providerId: Number(providerId), average: Number(average) };
  });
  ordersPerDepartmentTop5.sort((left, right) => left.departmentId - right.departmentId);
  averageEncountersPerPatientByProvider.sort((left, right) => left.providerId - right.providerId);
  const sensitiveColumns = [...parsed.entries()]
    .filter(([key]) => key.startsWith('sensitiveColumns|'))
    .map(([key]) => key.slice('sensitiveColumns|'.length))
    .sort();
  return {
    source: 'si_testbed_sqlserver',
    rowCounts: numericMap(parsed, 'rowCounts'),
    columnCounts: numericMap(parsed, 'columnCounts'),
    foreignKeys,
    viewNames: [...parsed.keys()].filter((key) => key.startsWith('viewNames|')).map((key) => key.slice('viewNames|'.length)).sort(),
    procedureNames: [...parsed.keys()].filter((key) => key.startsWith('procedureNames|')).map((key) => key.slice('procedureNames|'.length)).sort(),
    sensitiveColumns,
    nullRates: numericMap(parsed, 'nullRates'),
    metrics: numericMap(parsed, 'metrics'),
    inferredRelationship: {
      from: 'encounters.patient_id', to: 'patients.patient_id', matches: inferredMatches,
      sourceCount: inferredSourceCount, targetCount: inferredTargetCount, declared: false,
    },
    sharedPatientIds: sharedCount(pgPatientIds, patientIds),
    sharedEncounterIds: sharedCount(pgEncounterIds, encounterIds),
    answerMetrics: { emergencyVisits2025, ordersPerDepartmentTop5, averageEncountersPerPatientByProvider },
  };
}

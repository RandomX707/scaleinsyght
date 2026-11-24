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
  inferredRelationships:Array<{from:string;to:string;matches:number;sourceCount:number;confidence:number;declared:false}>;
  expectedRelationships:Array<{from:string;to:string;evidenceMethod:'declared'|'inferred';confidence:number}>;
  sharedPatientIds: number;
  sharedEncounterIds: number;
  answerMetrics: {
    emergencyVisits2025: number;
    ordersPerDepartmentTop5: Array<{ departmentId: number; departmentName: string; orderCount: number }>;
    ordersPerDepartment: Array<{ departmentId: number; departmentName: string; orderCount: number }>;
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
UNION ALL SELECT 'metrics|patients_with_phone|' + CONVERT(varchar(40),COUNT_BIG(phone)) FROM dbo.patients
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
UNION ALL SELECT 'ordersPerDepartment|' + CONVERT(varchar(10),d.department_id) + '|' + d.department_name + '|' + CONVERT(varchar(30),COUNT_BIG(*))
FROM dbo.departments d JOIN dbo.orders o ON o.department_id=d.department_id GROUP BY d.department_id,d.department_name
UNION ALL SELECT 'averageEncountersPerPatientByProvider|' + CONVERT(varchar(10),provider_id) + '|' + CONVERT(varchar(40),AVG(CAST(encounter_count AS float)),3)
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
  const candidateLines=runSqlServerAdminQuery(`SET NOCOUNT ON;
SELECT ss.name+'.'+st.name+'|'+sc.name+'|'+ts.name+'.'+tt.name+'|'+tc.name
FROM sys.columns sc JOIN sys.tables st ON st.object_id=sc.object_id JOIN sys.schemas ss ON ss.schema_id=st.schema_id
JOIN sys.columns tc ON tc.name=sc.name JOIN sys.tables tt ON tt.object_id=tc.object_id JOIN sys.schemas ts ON ts.schema_id=tt.schema_id
JOIN sys.types stype ON stype.user_type_id=sc.user_type_id JOIN sys.types ttype ON ttype.user_type_id=tc.user_type_id AND ttype.system_type_id=stype.system_type_id
JOIN sys.index_columns ik ON ik.object_id=tc.object_id AND ik.column_id=tc.column_id JOIN sys.indexes ix ON ix.object_id=ik.object_id AND ix.index_id=ik.index_id AND ix.is_primary_key=1
WHERE st.object_id<>tt.object_id AND ss.name='dbo' AND ts.name='dbo'
AND NOT EXISTS(SELECT 1 FROM sys.index_columns sik JOIN sys.indexes six ON six.object_id=sik.object_id AND six.index_id=sik.index_id AND six.is_primary_key=1 WHERE sik.object_id=sc.object_id AND sik.column_id=sc.column_id)
AND NOT EXISTS(SELECT 1 FROM sys.foreign_key_columns f JOIN sys.columns fc ON fc.object_id=f.parent_object_id AND fc.column_id=f.parent_column_id JOIN sys.columns tc2 ON tc2.object_id=f.referenced_object_id AND tc2.column_id=f.referenced_column_id WHERE f.parent_object_id=st.object_id AND f.referenced_object_id=tt.object_id AND fc.name=sc.name AND tc2.name=tc.name)
ORDER BY ss.name,st.name,sc.name,ts.name,tt.name,tc.name;`, 'si_testbed_sqlserver');
  const inferredRelationships:Array<{from:string;to:string;matches:number;sourceCount:number;confidence:number;declared:false}>=[];
  const quoteSql=(value:string)=>`[${value.replaceAll(']',']]')}]`;
  for(const line of candidateLines.split(/\r?\n/).filter(Boolean)){const [fromTable,fromColumn,toTable,toColumn]=line.split('|');if(!fromTable||!fromColumn||!toTable||!toColumn)continue;const sourceParts=fromTable.split('.'),targetParts=toTable.split('.');const counts=runSqlServerAdminQuery(`SET NOCOUNT ON;SELECT COUNT_BIG(src.${quoteSql(fromColumn)}) AS source_count,COUNT_BIG(dst.${quoteSql(toColumn)}) AS matches FROM ${quoteSql(sourceParts[0]!)}.${quoteSql(sourceParts[1]!)} src LEFT JOIN ${quoteSql(targetParts[0]!)}.${quoteSql(targetParts[1]!)} dst ON src.${quoteSql(fromColumn)}=dst.${quoteSql(toColumn)};`,'si_testbed_sqlserver').split(/\r?\n/).filter(Boolean).at(-1)?.split(/\s+/)??[];const sourceCount=Number(counts[0]),matches=Number(counts[1]);if(sourceCount&&matches/sourceCount>=0.98)inferredRelationships.push({from:`${fromTable}.${fromColumn}`,to:`${toTable}.${toColumn}`,matches,sourceCount,confidence:matches/sourceCount,declared:false});}
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
  ordersPerDepartmentTop5.sort((left, right) => right.orderCount - left.orderCount || left.departmentId - right.departmentId);
  const ordersPerDepartment = answerMetricLines.filter((line) => line.startsWith('ordersPerDepartment|')).map((line) => {
    const [, departmentId, departmentName, orderCount] = line.split('|');
    return { departmentId: Number(departmentId), departmentName: departmentName ?? '', orderCount: Number(orderCount) };
  }).sort((left, right) => right.orderCount - left.orderCount || left.departmentId - right.departmentId);
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
    inferredRelationships,
    expectedRelationships:[...foreignKeys.map(item=>({from:`dbo.${item.from}`,to:`dbo.${item.to}`,evidenceMethod:'declared' as const,confidence:1})),...inferredRelationships.map(item=>({from:item.from,to:item.to,evidenceMethod:'inferred' as const,confidence:item.confidence}))],
    sharedPatientIds: sharedCount(pgPatientIds, patientIds),
    sharedEncounterIds: sharedCount(pgEncounterIds, encounterIds),
    answerMetrics: { emergencyVisits2025, ordersPerDepartmentTop5, ordersPerDepartment, averageEncountersPerPatientByProvider },
  };
}

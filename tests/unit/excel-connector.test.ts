import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createExcelConnector, parseWorkbook } from '@scaleinsyght/connectors';
import { parseQueryIntent } from '@scaleinsyght/contracts';

type ExcelTruth = {
  sheets: Array<{ name: string; rowCount: number; columnCount: number; columns: string[]; headers: string[] }>;
  expectedInferredSensitivity: Record<string, string[]>;
  nullRates: Record<string, number>;
  sensitiveColumns: Record<string, string[]>;
  relationships: Array<{ from: string; to: string; column: string; matches: number; sourceCount: number; confidence: number }>;
  answerChecks: { visitCount: number; visitsWithDischargeDate: number; cancelledCharges: number; chargeAmountByDepartmentTop5: Array<{ department: string; amount: number }>; averageVisitsPerPatientByDepartment: Array<{ department: string; average: number }>; patientCount: number };
};
const truth = (JSON.parse(readFileSync('testbed/truth.json', 'utf8')) as { excel: ExcelTruth }).excel;
const workbook = readFileSync('testbed/excel/hospital-operations.xlsx');
const connector = createExcelConnector({ id: 'workbook', name: 'Operations workbook', workbook });
const run = (intent: unknown) => connector.executeQueryIntent(parseQueryIntent(intent), true);

describe('Excel workbook connector', () => {
  afterAll(async () => connector.close());

  it('c6_excel_connector_profiles_sheets_columns_and_null_rates_matching_truth', async () => {
    expect(await connector.test()).toEqual({ ok: true, capabilities: ['discover', 'profile'], readOnly: true });
    const discovered = await connector.discover({ mode: 'profile' });
    expect(discovered.objects.map((object) => object.qualifiedName)).toEqual(truth.sheets.map((sheet) => sheet.name));
    for (const object of discovered.objects) {
      const profile = await connector.profile(object.assetKey);
      const expected = truth.sheets.find((sheet) => sheet.name === object.qualifiedName)!;
      expect(profile.rowCount).toBe(expected.rowCount);
      expect(profile.columns.map((column) => column.name)).toEqual(expected.columns);
      // The original header text is kept for display; the identifier is only for SQL.
      expect(profile.columns.map((column) => column.label)).toEqual(expected.headers);
      for (const column of profile.columns) {
        const key = `${object.qualifiedName}.${column.name}`;
        expect(column.sensitivityTags).toEqual(truth.sensitiveColumns[key] ?? []);
        // Statistics on tagged columns are withheld; untagged columns match the file.
        if (column.sensitivityTags.length) expect(column.statistics).toEqual({ nullRate: null, distinctCount: null });
        else expect(column.statistics.nullRate).toBeCloseTo(truth.nullRates[key]!, 10);
      }
    }
    const visits = await connector.profile(discovered.objects.find((object) => object.qualifiedName === 'Visits')!.assetKey);
    expect(Object.fromEntries(visits.columns.map((column) => [column.name, column.dataType]))).toEqual({ visit_id: 'integer', patient_id: 'integer', department: 'text', provider_id: 'integer', admitted_on: 'timestamp', discharged_on: 'timestamp' });
  });

  it('c7_excel_connector_classifies_untagged_sensitive_columns_by_name_and_value_format', async () => {
    const discovered = await connector.discover({ mode: 'profile' });
    const registrations = await connector.profile(discovered.objects.find((object) => object.qualifiedName === 'Registrations')!.assetKey);
    for (const [key, tags] of Object.entries(truth.expectedInferredSensitivity)) {
      const column = registrations.columns.find((item) => `Registrations.${item.name}` === key)!;
      expect(column.sensitivityTags).toEqual(tags);
      expect(column.sensitivityEvidence?.every((item) => item.detection === 'inferred' && item.reason.length > 0)).toBe(true);
      expect(column.statistics).toEqual({ nullRate: null, distinctCount: null });
    }
    const patients = await connector.profile(discovered.objects.find((object) => object.qualifiedName === 'Patients')!.assetKey);
    expect(patients.columns.find((item) => item.name === 'mrn')!.sensitivityEvidence?.[0]).toMatchObject({ tag: 'identifier', detection: 'declared' });
  });

  it('c6_excel_connector_infers_sheet_relationships_with_coverage', async () => {
    const references = await connector.structuralReferences();
    expect(references.every((reference) => reference.evidenceMethod === 'inferred')).toBe(true);
    const actual = references.map((reference) => ({ from: reference.from, to: reference.to, column: reference.fromColumn, matches: reference.matchedCount, sourceCount: reference.sourceCount, confidence: reference.confidence }));
    const order = (items: typeof actual) => [...items].sort((left, right) => `${left.from}${left.column}${left.to}`.localeCompare(`${right.from}${right.column}${right.to}`));
    expect(order(actual)).toEqual(order(truth.relationships));
  });

  it('c3_excel_connector_runs_typed_intents_in_memory_matching_truth', async () => {
    const checks = truth.answerChecks;
    expect(Number((await run({ kind: 'count', table: 'Visits' })).rows[0]?.value)).toBe(checks.visitCount);
    expect(Number((await run({ kind: 'filtered_count', table: 'Visits', column: 'discharged_on', operator: 'is_not_null' })).rows[0]?.value)).toBe(checks.visitsWithDischargeDate);
    const cancelled = await run({ kind: 'filtered_count', table: 'Charges', column: 'status', operator: 'eq', value: 'cancelled' });
    expect(Number(cancelled.rows[0]?.value)).toBe(checks.cancelledCharges);
    expect(cancelled.sql).toContain('$1');
    const top = await run({ kind: 'group_by', table: 'Charges', groupBy: 'department', aggregate: { operation: 'sum', column: 'amount' }, orderBy: 'value', order: 'desc', limit: 5 });
    expect(top.rows.map((row) => ({ department: row.group_value, amount: Math.round(Number(row.value) * 100) / 100 }))).toEqual(checks.chargeAmountByDepartmentTop5);
    expect(top.rows.every((row) => Number(row.cell_size) >= 5)).toBe(true);
    const average = await run({ kind: 'average_count_by', table: 'Visits', entityColumn: 'patient_id', groupBy: 'department' });
    expect(average.rows.map((row) => ({ department: row.group_value, average: Math.round(Number(row.value) * 1e6) / 1e6 }))).toEqual(checks.averageVisitsPerPatientByDepartment.map((row) => ({ department: row.department, average: Math.round(row.average * 1e6) / 1e6 })));
    expect(Number((await run({ kind: 'count', table: 'Patients' })).rows[0]?.value)).toBe(checks.patientCount);
  });

  it('c3_excel_connector_rejects_unknown_sheets_and_columns', async () => {
    await expect(run({ kind: 'count', table: 'Payroll' })).rejects.toThrow('analytic_query_asset_not_found');
    await expect(run({ kind: 'filtered_count', table: 'Visits', column: 'salary', operator: 'is_not_null' })).rejects.toThrow('analytic_query_column_not_found');
  });

  it('c7_excel_upload_rejects_non_workbook_files', async () => {
    await expect(parseWorkbook(Buffer.from('patient_id,name\n1,Patient 0001\n'))).rejects.toThrow('excel_workbook_not_xlsx');
    await expect(parseWorkbook(Buffer.alloc(0))).rejects.toThrow('excel_workbook_size_invalid');
    await expect(parseWorkbook(Buffer.from('PK\x03\x04 not really a zip'))).rejects.toThrow('excel_workbook_not_xlsx');
  });
});

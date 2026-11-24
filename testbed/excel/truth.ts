// Truth for the testbed workbook, read directly from its cells with exceljs. Deliberately independent of the
// product's Excel connector so the connector is checked against the file, not against itself.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';

type Value = string | number | boolean | Date | null;
const plain = (raw: ExcelJS.CellValue): Value => {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object' && !(raw instanceof Date)) return null;
  return raw as Value;
};

export async function collectExcelTruth() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(resolve('testbed/excel/hospital-operations.xlsx'));
  const sheets = workbook.worksheets.map((sheet) => {
    const headers: string[] = []; const notes: string[] = [];
    sheet.getRow(1).eachCell((cell, index) => { headers[index - 1] = String(cell.value); const note = cell.note; notes[index - 1] = typeof note === 'string' ? note : (note?.texts ?? []).map((part) => part.text).join(''); });
    const rows: Value[][] = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const values = headers.map((_, index) => plain(sheet.getRow(rowNumber).getCell(index + 1).value));
      if (values.some((value) => value !== null)) rows.push(values);
    }
    return { name: sheet.name, headers, notes, rows };
  });
  const sheet = (name: string) => sheets.find((item) => item.name === name)!;
  const column = (sheetName: string, header: string) => { const target = sheet(sheetName); const index = target.headers.indexOf(header); return target.rows.map((row) => row[index] ?? null); };
  const snake = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  const nullRates: Record<string, number> = {};
  const sensitiveColumns: Record<string, string[]> = {};
  for (const item of sheets) item.headers.forEach((header, index) => {
    const values = item.rows.map((row) => row[index] ?? null);
    nullRates[`${item.name}.${snake(header)}`] = values.filter((value) => value === null).length / values.length;
    const tags = [...(item.notes[index] ?? '').matchAll(/sensitivity:([a-z_]+)/g)].map((match) => match[1]!);
    if (tags.length) sensitiveColumns[`${item.name}.${snake(header)}`] = tags;
  });

  // Columns with no header note that the testbed intends to be classified anyway (decision 41).
  const expectedInferred = JSON.parse(readFileSync(resolve('testbed/excel/expected-sensitivity.json'), 'utf8')) as Record<string, string[]>;
  for (const [key, tags] of Object.entries(expectedInferred)) sensitiveColumns[key] = [...new Set([...(sensitiveColumns[key] ?? []), ...tags])];
  const personalOrRegulated = (sheetName: string, header: string) => (sensitiveColumns[`${sheetName}.${snake(header)}`] ?? []).some((tag) => tag === 'personal' || tag === 'regulated');

  // Same header on two sheets, unique non-null target, coverage >= 98%. Never on personal or regulated columns.
  const relationships: Array<{ from: string; to: string; column: string; matches: number; sourceCount: number; confidence: number }> = [];
  for (const target of sheets) for (const header of target.headers) {
    if (personalOrRegulated(target.name, header)) continue;
    const targetValues = column(target.name, header);
    if (targetValues.some((value) => value === null) || new Set(targetValues.map(String)).size !== targetValues.length) continue;
    const keys = new Set(targetValues.map(String));
    for (const source of sheets) {
      if (source === target || !source.headers.includes(header)) continue;
      const values = column(source.name, header).filter((value) => value !== null);
      const matches = values.filter((value) => keys.has(String(value))).length;
      if (values.length && matches / values.length >= 0.98) relationships.push({ from: source.name, to: target.name, column: snake(header), matches, sourceCount: values.length, confidence: matches / values.length });
    }
  }

  const departments = column('Visits', 'Department') as string[];
  const visitPatients = column('Visits', 'Patient ID') as number[];
  const perDepartmentPatient = new Map<string, Map<number, number>>();
  departments.forEach((department, index) => { const patients = perDepartmentPatient.get(department) ?? new Map<number, number>(); patients.set(visitPatients[index]!, (patients.get(visitPatients[index]!) ?? 0) + 1); perDepartmentPatient.set(department, patients); });
  const averageVisitsPerPatientByDepartment = [...perDepartmentPatient.entries()].map(([department, patients]) => ({ department, average: [...patients.values()].reduce((sum, count) => sum + count, 0) / patients.size })).sort((left, right) => left.department.localeCompare(right.department));
  const amounts = column('Charges', 'Amount') as number[];
  const chargeDepartments = column('Charges', 'Department') as string[];
  const totals = new Map<string, number>();
  chargeDepartments.forEach((department, index) => totals.set(department, (totals.get(department) ?? 0) + amounts[index]!));
  const chargeAmountByDepartmentTop5 = [...totals.entries()].map(([department, amount]) => ({ department, amount: Math.round(amount * 100) / 100 })).sort((left, right) => right.amount - left.amount || left.department.localeCompare(right.department)).slice(0, 5);

  return {
    file: 'testbed/excel/hospital-operations.xlsx',
    sheets: sheets.map((item) => ({ name: item.name, rowCount: item.rows.length, columnCount: item.headers.length, columns: item.headers.map(snake), headers: item.headers })),
    expectedInferredSensitivity: expectedInferred,
    nullRates, sensitiveColumns, relationships,
    answerChecks: {
      visitCount: sheet('Visits').rows.length,
      visitsWithDischargeDate: column('Visits', 'Discharged On').filter((value) => value !== null).length,
      cancelledCharges: column('Charges', 'Status').filter((value) => value === 'cancelled').length,
      chargeAmountByDepartmentTop5,
      averageVisitsPerPatientByDepartment,
      patientCount: sheet('Patients').rows.length,
    },
  };
}

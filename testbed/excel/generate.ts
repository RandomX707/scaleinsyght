// Writes testbed/excel/hospital-operations.xlsx from the same seeded rows as the database testbed, so patient
// and visit identifiers overlap with both databases. Four overlapping sheets:
//   Patients - patients with a 2025 visit (sensitive columns carry a header note)
//   Visits   - the 2025 encounters, with department names and some blank discharge dates
//   Charges  - the orders for those visits
//   Registrations - a subset of those patients with NO header notes: the sensitivity detector must still
//                   classify name, date of birth, MRN and phone (decision 41)
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { testbedRows } from '../generate.js';

const { departments, patients, encounters, orders } = testbedRows;
const departmentName = new Map<number, string>(departments.map((department) => [department.id, department.name]));
const inYear = (date: Date) => date >= new Date(Date.UTC(2025, 0, 1)) && date < new Date(Date.UTC(2026, 0, 1));
const visits = encounters.filter((encounter) => inYear(encounter.admittedAt)).sort((left, right) => left.id - right.id);
const visitIds = new Set(visits.map((visit) => visit.id));
const visitPatients = new Set(visits.map((visit) => visit.patientId));
const sheetPatients = patients.filter((patient) => visitPatients.has(patient.id));
const charges = orders.filter((order) => visitIds.has(order.encounterId)).sort((left, right) => left.id - right.id);
const patientForVisit = new Map(visits.map((visit) => [visit.id, visit.patientId]));

const fixed = new Date(Date.UTC(2026, 0, 15));
const workbook = new ExcelJS.Workbook();
workbook.creator = 'Scale Insyght testbed';
workbook.created = fixed;
workbook.modified = fixed;

function addSheet(name: string, columns: Array<{ header: string; width: number; note?: string; format?: string }>, rows: unknown[][]) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((column) => ({ header: column.header, width: column.width, ...(column.format ? { style: { numFmt: column.format } } : {}) }));
  sheet.getRow(1).font = { bold: true };
  columns.forEach((column, index) => { if (column.note) sheet.getRow(1).getCell(index + 1).note = column.note; });
  for (const row of rows) sheet.addRow(row);
}

addSheet('Patients', [
  { header: 'Patient ID', width: 12 },
  { header: 'MRN', width: 14, note: 'sensitivity:identifier' },
  { header: 'Full Name', width: 18, note: 'sensitivity:personal' },
  { header: 'Date of Birth', width: 14, note: 'sensitivity:regulated', format: 'yyyy-mm-dd' },
  // Phone is blank for some patients in the workbook (a different gap from either database).
  { header: 'Phone', width: 14, note: 'sensitivity:personal' },
], sheetPatients.map((patient) => [patient.id, patient.mrn, patient.name, new Date(`${patient.dateOfBirth}T00:00:00Z`), patient.id % 5 === 0 ? null : patient.phone]));

addSheet('Visits', [
  { header: 'Visit ID', width: 10 },
  { header: 'Patient ID', width: 12 },
  { header: 'Department', width: 16 },
  { header: 'Provider ID', width: 12 },
  { header: 'Admitted On', width: 18, format: 'yyyy-mm-dd hh:mm' },
  { header: 'Discharged On', width: 18, format: 'yyyy-mm-dd hh:mm' },
], visits.map((visit) => [visit.id, visit.patientId, departmentName.get(visit.departmentId)!, visit.providerId, visit.admittedAt, visit.dischargedAt]));

addSheet('Charges', [
  { header: 'Charge ID', width: 11 },
  { header: 'Visit ID', width: 10 },
  { header: 'Patient ID', width: 12 },
  { header: 'Department', width: 16 },
  { header: 'Charge Type', width: 13 },
  { header: 'Status', width: 12 },
  { header: 'Amount', width: 11, format: '#,##0.00' },
  { header: 'Charged On', width: 18, format: 'yyyy-mm-dd hh:mm' },
], charges.map((charge) => [charge.id, charge.encounterId, patientForVisit.get(charge.encounterId)!, departmentName.get(charge.departmentId)!, charge.type, charge.status, charge.amount, charge.orderedAt]));

// Every third patient with a visit registered online; blank phone for some.
const registrations = sheetPatients.filter((patient) => patient.id % 3 === 0);
addSheet('Registrations', [
  { header: 'Patient ID', width: 12 },
  { header: 'Full Name', width: 18 },
  { header: 'Date of Birth', width: 14, format: 'yyyy-mm-dd' },
  { header: 'MRN', width: 14 },
  { header: 'Phone Number', width: 16 },
  { header: 'Registered On', width: 18, format: 'yyyy-mm-dd hh:mm' },
], registrations.map((patient) => [patient.id, patient.name, new Date(`${patient.dateOfBirth}T00:00:00Z`), patient.mrn, patient.id % 4 === 0 ? null : patient.phone, new Date(patient.createdAt.getTime() + 30 * 86_400_000)]));

// What the testbed intends each untagged sensitive column to be classified as. Truth records this intent;
// it is not computed by the product's detector.
writeFileSync(resolve('testbed/excel/expected-sensitivity.json'), `${JSON.stringify({ 'Registrations.full_name': ['personal'], 'Registrations.date_of_birth': ['regulated'], 'Registrations.mrn': ['identifier'], 'Registrations.phone_number': ['personal'] }, null, 2)}\n`);

const path = resolve('testbed/excel/hospital-operations.xlsx');
await workbook.xlsx.writeFile(path);
process.stdout.write(`Testbed workbook written: ${sheetPatients.length} patients, ${visits.length} visits, ${charges.length} charges.\n`);

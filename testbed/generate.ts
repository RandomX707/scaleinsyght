// Deterministic generator for the fictional testbed hospital. Writes the same rows (same patient,
// encounter and order ids) to testbed/postgres/data.sql and testbed/sqlserver/data.sql.
// Distributions are deliberately skewed: a couple of busy departments with a long tail, most
// patients with one encounter and a few with ten or more, and uneven provider loads.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261124);
const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
function weighted<T>(items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (let index = 0; index < items.length; index++) { roll -= weights[index]!; if (roll < 0) return items[index]!; }
  return items[items.length - 1]!;
}
function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index--) { const other = int(0, index); [items[index], items[other]] = [items[other]!, items[index]!]; }
  return items;
}

// Exact order counts per department: two busy departments, a long tail, no ties in the top five,
// and one deliberate tie in the tail (Orthopedics and Psychiatry).
export const departments = [
  { id: 1, name: 'Cardiology', orders: 152 }, { id: 2, name: 'Neurology', orders: 52 },
  { id: 3, name: 'Emergency', orders: 388 }, { id: 4, name: 'Imaging', orders: 197 },
  { id: 5, name: 'Laboratory', orders: 301 }, { id: 6, name: 'Surgery', orders: 121 },
  { id: 7, name: 'Oncology', orders: 88 }, { id: 8, name: 'Pediatrics', orders: 64 },
  { id: 9, name: 'Orthopedics', orders: 41 }, { id: 10, name: 'Psychiatry', orders: 41 },
  { id: 11, name: 'Dermatology', orders: 30 }, { id: 12, name: 'Rehabilitation', orders: 25 },
] as const;

const providerDepartments = [3, 3, 3, 5, 5, 4, 4, 1, 1, 6, 6, 7, 7, 8, 2, 9, 10, 11, 12, 3, 5, 4, 1, 8];
const specialties = ['General', 'Cardiology', 'Radiology', 'Surgery'];
const providers = providerDepartments.map((departmentId, index) => ({ id: index + 1, departmentId, name: `Provider ${String(index + 1).padStart(3, '0')}`, specialty: specialties[index % 4]! }));
// Uneven provider loads: a Zipf-like weight over a shuffled provider order.
const providerWeights = shuffle(providers.map((_, index) => 1 / Math.pow(index + 1, 0.9)));

const patients = Array.from({ length: 500 }, (_, index) => {
  const id = index + 1;
  const birth = new Date(Date.UTC(1940, 0, 1) + ((id * 37) % 26000) * 86_400_000);
  return { id, name: `Patient ${String(id).padStart(4, '0')}`, dateOfBirth: birth.toISOString().slice(0, 10), mrn: `MRN-${String(id).padStart(6, '0')}`, phone: `555-01${String(id).padStart(5, '0')}`, createdAt: new Date(Date.UTC(2024, 0, 1) + id * 60_000) };
});

// Encounters per patient: most 1, many 2-4, some 5-9, a few 10-16.
const visitCounts = patients.map(() => { const roll = random(); return roll < 0.55 ? 1 : roll < 0.88 ? int(2, 4) : roll < 0.97 ? int(5, 9) : int(10, 16); });
const primaryProvider = patients.map(() => weighted(providers, providerWeights));
const windowStart = Date.UTC(2024, 6, 1), windowHours = Math.floor((Date.UTC(2026, 3, 1) - windowStart) / 3_600_000);
const encounterDrafts = shuffle(patients.flatMap((patient, index) => Array.from({ length: visitCounts[index]! }, () => {
  const provider = random() < 0.7 ? primaryProvider[index]! : weighted(providers, providerWeights);
  const admittedAt = new Date(windowStart + int(0, windowHours - 1) * 3_600_000);
  const dischargedAt = random() < 0.12 ? null : new Date(admittedAt.getTime() + int(2, 240) * 3_600_000);
  return { patientId: patient.id, providerId: provider.id, departmentId: provider.departmentId, admittedAt, dischargedAt };
})));
const encounters = encounterDrafts.map((draft, index) => ({ id: index + 1, ...draft }));

const encountersByDepartment = new Map<number, typeof encounters>();
for (const encounter of encounters) encountersByDepartment.set(encounter.departmentId, [...(encountersByDepartment.get(encounter.departmentId) ?? []), encounter]);
const orderDepartments = shuffle(departments.flatMap((department) => Array.from({ length: department.orders }, () => department.id)));
const orders = orderDepartments.map((departmentId, index) => {
  const pool = encountersByDepartment.get(departmentId) ?? encounters;
  const encounter = pool[int(0, pool.length - 1)]!;
  return {
    id: index + 1, encounterId: encounter.id, departmentId,
    type: weighted(['lab', 'medication', 'imaging', 'procedure'], [35, 30, 20, 15]),
    status: weighted(['completed', 'placed', 'cancelled'], [60, 25, 15]),
    orderedAt: new Date(encounter.admittedAt.getTime() + int(0, 48) * 3_600_000),
    amount: (500 + Math.floor(random() ** 2 * 49_500)) / 100,
  };
});

const counts = visitCounts.reduce<Record<string, number>>((tally, count) => { const bucket = count === 1 ? '1' : count <= 4 ? '2-4' : count <= 9 ? '5-9' : '10+'; tally[bucket] = (tally[bucket] ?? 0) + 1; return tally; }, {});
if ((counts['1'] ?? 0) <= 250 || (counts['2-4'] ?? 0) < 100 || (counts['10+'] ?? 0) < 5) throw new Error(`testbed_distribution_unrealistic ${JSON.stringify(counts)}`);

const pgText = (value: string | null) => value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
const msText = (value: string | null) => value === null ? 'NULL' : `N'${value.replaceAll("'", "''")}'`;
const pgTime = (value: Date | null) => value === null ? 'NULL' : `'${value.toISOString().slice(0, 19).replace('T', ' ')}+00'`;
const msTime = (value: Date | null) => value === null ? 'NULL' : `'${value.toISOString().slice(0, 19)}'`;
function inserts(table: string, columns: string, rows: string[], batch: number): string {
  const statements: string[] = [];
  for (let index = 0; index < rows.length; index += batch) statements.push(`INSERT INTO ${table}(${columns}) VALUES\n${rows.slice(index, index + batch).join(',\n')};`);
  return statements.join('\n');
}
type Dialect = { text: (value: string | null) => string; time: (value: Date | null) => string; prefix: string; phoneGap: number };
function render(dialect: Dialect): string {
  const { text, time, prefix } = dialect;
  return [
    inserts(`${prefix}departments`, 'department_id,department_code,department_name', departments.map((d) => `(${d.id},${text(`D-${String(d.id).padStart(3, '0')}`)},${text(d.name)})`), 500),
    inserts(`${prefix}providers`, 'provider_id,department_id,provider_name,specialty', providers.map((p) => `(${p.id},${p.departmentId},${text(p.name)},${text(p.specialty)})`), 500),
    // Phone gaps differ per system so each source has its own completeness.
    inserts(`${prefix}patients`, 'patient_id,name,date_of_birth,mrn,phone,created_at', patients.map((p) => `(${p.id},${text(p.name)},'${p.dateOfBirth}',${text(p.mrn)},${p.id % dialect.phoneGap === 0 ? 'NULL' : text(p.phone)},${time(p.createdAt)})`), 500),
    inserts(`${prefix}encounters`, 'encounter_id,patient_id,department_id,provider_id,admitted_at,discharged_at', encounters.map((e) => `(${e.id},${e.patientId},${e.departmentId},${e.providerId},${time(e.admittedAt)},${time(e.dischargedAt)})`), 500),
    inserts(`${prefix}orders`, 'order_id,encounter_id,department_id,order_type,order_status,ordered_at,amount', orders.map((o) => `(${o.id},${o.encounterId},${o.departmentId},${text(o.type)},${text(o.status)},${time(o.orderedAt)},${o.amount.toFixed(2)})`), 500),
  ].join('\n\n');
}

export const testbedRows = { departments, providers, patients, encounters, orders };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const header = '-- Generated by testbed/generate.ts. Do not edit; change the generator and run pnpm testbed:generate.\n';
  writeFileSync(resolve('testbed/postgres/data.sql'), `${header}${render({ text: pgText, time: pgTime, prefix: '', phoneGap: 7 })}\n\nANALYZE;\n`);
  writeFileSync(resolve('testbed/sqlserver/data.sql'), `${header}USE [si_testbed_sqlserver];\nGO\n${render({ text: msText, time: msTime, prefix: 'dbo.', phoneGap: 9 })}\nGO\n`);
  const rowCount = departments.length + providers.length + patients.length + encounters.length + orders.length;
  process.stdout.write(`Testbed data generated: ${rowCount.toLocaleString('en-US')} fictional rows (${encounters.length.toLocaleString('en-US')} encounters, ${orders.length.toLocaleString('en-US')} orders); encounters per patient ${JSON.stringify(counts)}.\n`);
}

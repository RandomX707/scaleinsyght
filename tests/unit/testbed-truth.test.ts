import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('testbed/postgres/schema.sql', 'utf8');
const truth = JSON.parse(readFileSync('testbed/truth.json', 'utf8')) as {
  rowCounts: Record<string, number>;
  columnCounts: Record<string, number>;
  foreignKeys: Array<{ from: string; to: string }>;
  inferredRelationship: { from: string; to: string };
  sensitiveColumns: string[];
  nullRates: Record<string, number>;
  metrics: Record<string, number>;
  answerChecks: {
    emergencyVisits2025: { postgres: number; sqlServer: number };
    ordersPerDepartmentTop5: { postgres: Array<{ departmentId: number; departmentName: string; orderCount: number }>; sqlServer: Array<{ departmentId: number; departmentName: string; orderCount: number }> };
    averageEncountersPerPatientByProvider: { postgres: Array<{ providerId: number; average: number }>; sqlServer: Array<{ providerId: number; average: number }> };
    patientCountComparison: { postgres: number; sqlServer: number; same: boolean };
    ordersPerDepartment: { postgres: Array<{ departmentId: number; departmentName: string; orderCount: number }> };
    encountersPerPatient: { postgres: Record<string, number> };
    sharedPatientsCount: number;
  };
};

const round6=(rows:Array<{providerId:number;average:number}>)=>rows.map(row=>({providerId:row.providerId,average:Math.round(row.average*1e6)/1e6}));

describe('real PostgreSQL testbed truth', () => {
  it('testbed_truth_is_sql_derived_and_has_expected_fixtures', () => {
    expect(Object.keys(truth.rowCounts)).toEqual(expect.arrayContaining([
      'patients', 'encounters', 'orders', 'departments', 'providers',
    ]));
    expect(Object.values(truth.rowCounts).reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(2_000);
    expect(Object.keys(truth.columnCounts)).toEqual(expect.arrayContaining([
      'patients', 'encounters', 'orders', 'departments', 'providers',
    ]));
    expect(truth.foreignKeys).toHaveLength(2);
    expect(truth.inferredRelationship.from).toBeTruthy();
    expect(truth.inferredRelationship.to).toBeTruthy();
    expect(truth.sensitiveColumns).toEqual(expect.arrayContaining([
      'patients.name', 'patients.date_of_birth', 'patients.mrn', 'patients.phone',
    ]));
    expect(Object.keys(truth.nullRates).length).toBeGreaterThan(0);
    expect(Object.keys(truth.metrics).length).toBeGreaterThan(0);
  });

  it('truth_contains_sql_derived_answers_for_the_s2_review_questions', () => {
    expect(truth.answerChecks.emergencyVisits2025.postgres).toBeGreaterThan(0);
    expect(truth.answerChecks.emergencyVisits2025.sqlServer).toBe(truth.answerChecks.emergencyVisits2025.postgres);
    expect(truth.answerChecks.ordersPerDepartmentTop5.sqlServer).toEqual(truth.answerChecks.ordersPerDepartmentTop5.postgres);
    expect(round6(truth.answerChecks.averageEncountersPerPatientByProvider.sqlServer)).toEqual(round6(truth.answerChecks.averageEncountersPerPatientByProvider.postgres));
    expect(truth.answerChecks.patientCountComparison).toEqual({ postgres: 500, sqlServer: 500, same: true });
    expect(truth.answerChecks.sharedPatientsCount).toBe(500);
  });

  it('testbed_distributions_are_skewed_not_uniform', () => {
    const top = truth.answerChecks.ordersPerDepartmentTop5.postgres.map((row) => row.orderCount);
    expect(top).toHaveLength(5);
    expect(new Set(top).size).toBe(5);
    expect(top).toEqual([...top].sort((left, right) => right - left));
    const all = truth.answerChecks.ordersPerDepartment.postgres.map((row) => row.orderCount);
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(all[0]! / all.at(-1)!).toBeGreaterThan(5);
    expect(all.length - new Set(all).size).toBeGreaterThan(0);
    const perPatient = Object.entries(truth.answerChecks.encountersPerPatient.postgres).map(([visits, patients]) => ({ visits: Number(visits), patients }));
    const patientsWith = (test: (visits: number) => boolean) => perPatient.filter((row) => test(row.visits)).reduce((sum, row) => sum + row.patients, 0);
    expect(patientsWith((visits) => visits === 1)).toBeGreaterThan(250);
    expect(patientsWith((visits) => visits >= 2 && visits <= 4)).toBeGreaterThanOrEqual(100);
    expect(patientsWith((visits) => visits >= 10)).toBeGreaterThanOrEqual(5);
    const averages = truth.answerChecks.averageEncountersPerPatientByProvider.postgres.map((row) => row.average);
    expect(Math.max(...averages) - Math.min(...averages)).toBeGreaterThan(0.5);
  });

  it('testbed_pg_has_five_hospital_tables_two_views_two_functions_sensitive_tags_and_undeclared_pair', () => {
    for (const table of ['patients', 'encounters', 'orders', 'departments', 'providers']) {
      expect(schema).toMatch(new RegExp(`CREATE TABLE\\s+(?:public\\.)?${table}\\b`, 'i'));
    }
    expect((schema.match(/CREATE VIEW\b/gi) ?? [])).toHaveLength(2);
    expect((schema.match(/CREATE (?:OR REPLACE )?FUNCTION\b/gi) ?? [])).toHaveLength(2);
    for (const column of ['name', 'date_of_birth', 'mrn', 'phone']) {
      expect(schema).toMatch(new RegExp(`COMMENT ON COLUMN\\s+patients\\.${column}\\s+IS\\s+'sensitivity:`, 'i'));
    }
    expect(truth.inferredRelationship).toMatchObject({ from: 'encounters.patient_id', to: 'patients.patient_id' });
  });
});

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
    sharedPatientsCount: number;
  };
};

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
    expect(truth.answerChecks.emergencyVisits2025).toEqual({ postgres: 117, sqlServer: 117 });
    for (const source of [truth.answerChecks.ordersPerDepartmentTop5.postgres, truth.answerChecks.ordersPerDepartmentTop5.sqlServer]) {
      expect(source).toEqual([1, 2, 3, 4, 5].map((departmentId) => ({ departmentId, departmentName: ['Cardiology','Neurology','Emergency','Imaging','Laboratory'][departmentId - 1], orderCount: 200 })));
    }
    for (const source of [truth.answerChecks.averageEncountersPerPatientByProvider.postgres, truth.answerChecks.averageEncountersPerPatientByProvider.sqlServer]) {
      expect(source).toHaveLength(24);
      expect(source.map((item) => item.providerId)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
      expect(source.every((item) => item.average === 1)).toBe(true);
    }
    expect(truth.answerChecks.patientCountComparison).toEqual({ postgres: 500, sqlServer: 500, same: true });
    expect(truth.answerChecks.sharedPatientsCount).toBe(500);
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

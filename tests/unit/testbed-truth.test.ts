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

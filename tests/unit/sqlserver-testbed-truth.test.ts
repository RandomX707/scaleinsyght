import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schemaPath = 'testbed/sqlserver/schema.sql';
const hasSchema = existsSync(schemaPath);
const schema = hasSchema ? readFileSync(schemaPath, 'utf8') : '';
const truth = JSON.parse(readFileSync('testbed/truth.json', 'utf8')) as {
  rowCounts: Record<string, number>;
  sqlServer?: {
    rowCounts: Record<string, number>;
    columnCounts: Record<string, number>;
    sharedPatientIds: number;
    sharedEncounterIds: number;
    viewNames: string[];
    procedureNames: string[];
  };
};

describe('SQL Server testbed truth contract', () => {
  it('sqlserver_testbed_truth_is_database_derived', () => {
    expect(hasSchema).toBe(true);
    for (const table of ['patients', 'encounters', 'orders', 'departments', 'providers']) {
      expect(schema).toMatch(new RegExp(`CREATE TABLE\\s+dbo\\.${table}\\b`, 'i'));
    }
    expect((schema.match(/CREATE VIEW\b/gi) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((schema.match(/CREATE(?:\s+OR\s+ALTER)?\s+PROCEDURE\b/gi) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(truth.sqlServer?.rowCounts).toEqual(expect.objectContaining({
      patients: truth.rowCounts.patients,
      encounters: truth.rowCounts.encounters,
      orders: truth.rowCounts.orders,
      departments: truth.rowCounts.departments,
      providers: truth.rowCounts.providers,
    }));
    expect(truth.sqlServer?.columnCounts).toEqual(expect.objectContaining({
      patients: expect.any(Number),
      encounters: expect.any(Number),
      orders: expect.any(Number),
      departments: expect.any(Number),
      providers: expect.any(Number),
    }));
    expect(truth.sqlServer?.viewNames.length).toBeGreaterThanOrEqual(1);
    expect(truth.sqlServer?.procedureNames.length).toBeGreaterThanOrEqual(1);
  });

  it('sqlserver_and_postgres_share_patient_and_encounter_keys', () => {
    expect(truth.sqlServer?.sharedPatientIds).toBeGreaterThan(0);
    expect(truth.sqlServer?.sharedEncounterIds).toBeGreaterThan(0);
  });
});

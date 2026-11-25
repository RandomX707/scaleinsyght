import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formulaReferences, readTableauWorkbook, splitBracketed } from '@scaleinsyght/tableau';

const fixture = readFileSync('tests/golden/tableau/sample-operations.twb', 'utf8');

describe('Tableau .twb reader', () => {
  it('reads data sources, relations, field mappings and worksheet fields from a documented-format workbook', () => {
    const workbook = readTableauWorkbook(fixture);
    expect(workbook.version).toBe('18.1');
    // The Parameters pseudo data source is not data and is skipped.
    expect(workbook.datasources.map((item) => [item.caption, item.connectionClass])).toEqual([
      ['Encounters by department', 'postgres'], ['Orders (custom SQL)', 'postgres'], ['Claims archive', 'postgres'], ['Budget workbook', 'excel-direct'],
    ]);
    const encounters = workbook.datasources[0]!;
    // The join and the object-model copy of the same tables are read once each.
    expect(encounters.relations).toEqual([
      { name: 'encounters', kind: 'table', schema: 'public', table: 'encounters' },
      { name: 'departments', kind: 'table', schema: 'public', table: 'departments' },
    ]);
    const field = (name: string) => encounters.fields.find((item) => item.name === name)!;
    expect(field('department_name')).toMatchObject({ caption: 'Department', source: { kind: 'column', relation: 'departments', column: 'department_name' } });
    expect(field('department_id (departments)').source).toEqual({ kind: 'column', relation: 'departments', column: 'department_id' });
    expect(field('Calculation_1002')).toMatchObject({ caption: 'Stay days', source: { kind: 'calculated', references: ['admitted_at', 'discharged_at'], usesParameters: false } });
    expect(field('Calculation_1003').source).toEqual({ kind: 'calculated', references: ['Calculation_1002'], usesParameters: false });
    expect(field('Calculation_1004').source).toEqual({ kind: 'calculated', references: ['Calculation_1001'], usesParameters: true });
    const sql = workbook.datasources[1]!.relations[0]!;
    expect(sql.kind).toBe('custom_sql');
    expect(sql.kind === 'custom_sql' && sql.sql).toMatch(/^SELECT o\.order_id/);
    expect(workbook.worksheets.map((sheet) => [sheet.name, sheet.fields.map((item) => item.field)])).toEqual([
      ['Encounters by department', ['department_name', 'Calculation_1001']],
      ['Long stays', ['Calculation_1003', 'department_name']],
      ['Orders by type', ['order_type', 'line_count', 'department_name']],
      ['Claims', ['claim_amount']],
      ['Budget', ['Budget']],
    ]);
  });

  it('returns no formula text, literals or connection details, only names', () => {
    const workbook = readTableauWorkbook(fixture);
    const withoutSql = JSON.stringify(workbook.datasources.map((item) => ({ ...item, relations: item.relations.map((relation) => relation.kind === 'custom_sql' ? { ...relation, sql: '' } : relation) })));
    for (const secret of ['tableau_reader', 'warehouse.riverside.example', 'riverside_operations', 'budget-secret-path', 'Over a week marker', 'COUNTD', 'DATEDIFF', 'not_a_field', 'Encounter target']) {
      expect(withoutSql).not.toContain(secret);
    }
  });

  it('finds formula references outside string literals and comments', () => {
    expect(formulaReferences(`IF [a] = "[not a]" THEN 'x[y]' END // [comment]\n+ [b]]c] /* [block] */ + [Parameters].[Limit] + [ds].[d]`))
      .toEqual({ references: ['a', 'b]c', 'd'], usesParameters: true });
    expect(formulaReferences('{FIXED [region] : SUM([sales])}')).toEqual({ references: ['region', 'sales'], usesParameters: false });
    expect(formulaReferences('"it""s [quoted]" + [real]')).toEqual({ references: ['real'], usesParameters: false });
  });

  it('splits bracketed identifiers including escaped brackets', () => {
    expect(splitBracketed('[public].[orders]')).toEqual(['public', 'orders']);
    expect(splitBracketed('[db].[dbo].[a]]b]')).toEqual(['db', 'dbo', 'a]b']);
    expect(splitBracketed('[Budget$]')).toEqual(['Budget$']);
  });

  it('refuses a DTD, so no entity is ever expanded', () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE workbook [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><workbook>&b;</workbook>`;
    expect(() => readTableauWorkbook(laughs)).toThrow('tableau_workbook_invalid');
    const external = `<?xml version="1.0"?><!DOCTYPE workbook [<!ENTITY x SYSTEM "file:///etc/passwd">]><workbook><datasources><datasource name="d">&x;</datasource></datasources></workbook>`;
    expect(() => readTableauWorkbook(external)).toThrow('tableau_workbook_invalid');
  });

  it('refuses anything that is not a workbook with data sources', () => {
    expect(() => readTableauWorkbook('<html><body/></html>')).toThrow('tableau_workbook_invalid');
    expect(() => readTableauWorkbook('<workbook><datasources>')).toThrow('tableau_workbook_invalid');
    expect(() => readTableauWorkbook('not xml at all')).toThrow('tableau_workbook_invalid');
    expect(() => readTableauWorkbook('<workbook><datasources/></workbook>')).toThrow('tableau_workbook_has_no_datasources');
    expect(() => readTableauWorkbook(Buffer.from('PK\u0003\u0004packaged'))).toThrow('tableau_twbx_unsupported');
  });
});

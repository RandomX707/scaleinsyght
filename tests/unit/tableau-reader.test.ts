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
      ['Encounters by department', 'postgres'], ['Orders (custom SQL)', 'postgres'], ['Claims archive', 'postgres'], ['orders', 'postgres'], ['Budget workbook', 'excel-direct'],
    ]);
    // Database names are read for matching only; Tableau's default caption "orders (other_warehouse)" loses its database.
    expect(workbook.datasources.map((item) => item.databases)).toEqual([['si_sample_source'], ['si_sample_source'], ['si_sample_source'], ['other_warehouse'], []]);
    const encounters = workbook.datasources[0]!;
    // The join and the object-model copy of the same tables are read once each.
    expect(encounters.relations).toEqual([
      { name: 'encounters', kind: 'table', schema: 'public', table: 'encounters' },
      { name: 'departments', kind: 'table', schema: 'public', table: 'departments' },
    ]);
    const field = (name: string) => encounters.fields.find((item) => item.name === name)!;
    expect(field('department_name')).toMatchObject({ caption: 'Department', source: { kind: 'column', relation: 'departments', column: 'department_name' } });
    expect(field('department_id (departments)').source).toEqual({ kind: 'column', relation: 'departments', column: 'department_id' });
    const local = (...fields: string[]) => fields.map((name) => ({ datasource: null, field: name }));
    expect(field('Calculation_1002')).toMatchObject({ caption: 'Stay days', source: { kind: 'calculated', references: local('admitted_at', 'discharged_at'), usesParameters: false } });
    expect(field('Calculation_1003').source).toEqual({ kind: 'calculated', references: local('Calculation_1002'), usesParameters: false });
    expect(field('Calculation_1004').source).toEqual({ kind: 'calculated', references: local('Calculation_1001'), usesParameters: true });
    // A formula naming another data source's field keeps which data source it is.
    expect(workbook.datasources[1]!.fields.find((item) => item.name === 'Calculation_2001')!.source)
      .toEqual({ kind: 'calculated', references: [{ datasource: 'federated.0sample1encounters', field: 'department_name' }], usesParameters: false });
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
    const withoutSql = JSON.stringify(workbook.datasources.map((item) => ({ ...item, databases: [], relations: item.relations.map((relation) => relation.kind === 'custom_sql' ? { ...relation, sql: '' } : relation) })));
    for (const secret of ['tableau_reader', 'warehouse.riverside.example', 'si_sample_source', 'other_warehouse', 'budget-secret-path', 'Over a week marker', 'COUNTD', 'DATEDIFF', 'not_a_field', 'Encounter target']) {
      expect(withoutSql).not.toContain(secret);
    }
  });

  it('finds formula references outside string literals and comments', () => {
    expect(formulaReferences(`IF [a] = "[not a]" THEN 'x[y]' END // [comment]\n+ [b]]c] /* [block] */ + [Parameters].[Limit] + [ds].[d]`))
      .toEqual({ references: [{ datasource: null, field: 'a' }, { datasource: null, field: 'b]c' }, { datasource: 'ds', field: 'd' }], usesParameters: true });
    expect(formulaReferences('{FIXED [region] : SUM([sales])}')).toEqual({ references: [{ datasource: null, field: 'region' }, { datasource: null, field: 'sales' }], usesParameters: false });
    expect(formulaReferences('"it""s [quoted]" + [real]')).toEqual({ references: [{ datasource: null, field: 'real' }], usesParameters: false });
    // An unterminated bracket ends the scan, so the text after it never becomes a field name.
    expect(formulaReferences('[a] + [never closed "literal"')).toEqual({ references: [{ datasource: null, field: 'a' }], usesParameters: false });
  });

  it('counts only the fields a worksheet places, not the column definitions it carries', () => {
    const sheet = `<workbook><datasources><datasource name='d' caption='D'><connection class='postgres' dbname='x'/></datasource></datasources>
      <worksheets><worksheet name='S'><table><view><datasource-dependencies datasource='d'><column name='[defined]'/><column name='[placed]'/>
      <column-instance column='[placed]' name='[none:placed:nk]'/></datasource-dependencies></view></table></worksheet>
      <worksheet name='Empty'><table><view><datasource-dependencies datasource='d'><column name='[defined]'/></datasource-dependencies></view></table></worksheet></worksheets></workbook>`;
    expect(readTableauWorkbook(sheet).worksheets).toEqual([{ name: 'S', fields: [{ datasource: 'd', field: 'placed' }] }, { name: 'Empty', fields: [] }]);
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

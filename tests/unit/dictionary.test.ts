import { describe, expect, it } from 'vitest';
import { classifyObject, draftDescription, groupFor, hasCustomPrefix, sqlSnippets } from '@scaleinsyght/api/dictionary';
import { renderDictionaryHtml, scriptJson } from '@scaleinsyght/api/dictionary-html';
import { analyseDefinition } from '@scaleinsyght/profiler';

describe('Dictionary custom detection (spec 2.1)', () => {
  it('finds the X_ token at the start or after an underscore, on the object name only', () => {
    for (const name of ['dbo.X_READMIT_FLAGS', 'dbo.usp_X_LOAD', 'dbo.rpt_X_BY_DEPT', 'public.x_census', 'X_JOB_LOG']) expect(hasCustomPrefix(name), name).toBe(true);
    for (const name of ['dbo.encounters', 'dbo.max_value', 'dbo.tax_rate', 'X_schema.encounters', 'dbo.idx_patients', 'public.f(x_a integer)']) expect(hasCustomPrefix(name), name).toBe(false);
  });
  // Decision 62: Standard means vendor-delivered, Custom customer-built; never Standard by default.
  const none = { vendor: null, rules: { customPrefixes: ['X_'], customSchemas: [] as string[], ownerPatterns: [] as string[] }, owner: null, copy: null };
  it('uses an imported vendor dictionary for the tables and views it lists', () => {
    const vendor = new Set(['dbo.patients']);
    expect(classifyObject({ name: 'dbo.patients', kind: 'table' }, { ...none, vendor })).toEqual({ origin: 'standard', reason: 'in_vendor_dictionary' });
    expect(classifyObject({ name: 'dbo.local_extract', kind: 'table' }, { ...none, vendor })).toEqual({ origin: 'custom', reason: 'not_in_vendor_dictionary' });
    // The dictionary lists tables and views, so a procedure it does not mention is decided by the rules.
    expect(classifyObject({ name: 'dbo.usp_load', kind: 'procedure' }, { ...none, vendor })).toEqual({ origin: 'unclassified', reason: null });
  });
  it('never calls an object Standard without a vendor dictionary', () => {
    for (const kind of ['table', 'view', 'procedure', 'function', 'sheet', 'model'] as const)
      expect(classifyObject({ name: 'dbo.local_extract', kind }, none)).toEqual({ origin: 'unclassified', reason: null });
    expect(classifyObject({ name: 'Long stay', kind: 'calculated_field' }, none)).toEqual({ origin: 'custom', reason: 'built_in_bi_tool' });
  });
  it('marks custom by name prefix, schema and owner rules from Controls', () => {
    expect(classifyObject({ name: 'dbo.usp_X_LOAD', kind: 'procedure' }, none)).toMatchObject({ origin: 'custom', reason: 'name_prefix' });
    expect(classifyObject({ name: 'dbo.Z_TEMP', kind: 'table' }, { ...none, rules: { ...none.rules, customPrefixes: ['Z_'] } })).toMatchObject({ reason: 'name_prefix' });
    expect(classifyObject({ name: 'local.extract', kind: 'table' }, { ...none, rules: { ...none.rules, customSchemas: ['LOCAL'] } })).toMatchObject({ origin: 'custom', reason: 'schema' });
    expect(classifyObject({ name: 'dbo.extract', kind: 'table' }, { ...none, owner: 'etl_nightly', rules: { ...none.rules, ownerPatterns: ['etl_*'] } })).toMatchObject({ origin: 'custom', reason: 'owner' });
    expect(classifyObject({ name: 'dbo.extract', kind: 'table' }, { ...none, owner: 'vendor_admin', rules: { ...none.rules, ownerPatterns: ['etl_*'] } })).toMatchObject({ origin: 'unclassified' });
  });
  it('marks a near-identical copy of another routine as custom', () => {
    expect(classifyObject({ name: 'dbo.fn_admit_copy', kind: 'function' }, { ...none, copy: { copyOf: 'dbo.usp_admit', similarity: 0.97 } })).toEqual({ origin: 'custom', reason: 'copy' });
  });
  it('groups custom procedures by their parsed kind', () => {
    expect(groupFor({ name: 'dbo.usp_X_LOAD', kind: 'procedure', procedureKind: 'fact_loader', columns: null, custom: true }).label).toBe('Procedures · Fact loaders');
    expect(groupFor({ name: 'dbo.usp_X_LOAD', kind: 'procedure', procedureKind: null, columns: null, custom: true }).label).toBe('Procedures · Utilities');
    expect(groupFor({ name: 'dbo.vendor_proc', kind: 'procedure', procedureKind: 'report', columns: null, custom: false }).label).toBe('Procedures');
    expect(groupFor({ name: 'dbo.X_V', kind: 'view', procedureKind: null, columns: 3, custom: true }).label).toBe('Custom views');
  });
});

describe('Dictionary search snippets', () => {
  it('returns numbered lines around the match, case-insensitive, at most three', () => {
    const text = 'CREATE PROCEDURE p @LookbackDays int AS\nBEGIN\n  SELECT 1 WHERE d <= @LookbackDays\n  -- lookbackdays\n  SELECT @lookbackdays\nEND';
    expect(sqlSnippets(text, 'lookbackdays')).toEqual([
      { line: 1, text: 'CREATE PROCEDURE p @LookbackDays int AS' }, { line: 3, text: 'SELECT 1 WHERE d <= @LookbackDays' }, { line: 4, text: '-- lookbackdays' },
    ]);
    expect(sqlSnippets(`${'x'.repeat(200)} needle ${'y'.repeat(200)}`, 'needle')[0]!.text).toMatch(/^….*needle.*…$/);
  });
});

describe('drafted descriptions use metadata only', () => {
  it('describes a loader from its parsed writes, reads and calls, without default schemas', () => {
    expect(draftDescription({ kind: 'procedure', name: 'dbo.usp_X_LOAD', analysis: { writes: [{ table: 'dbo.X_FLAGS', mode: 'truncate-insert' }], reads: ['dbo.encounters'], calls: ['dbo.usp_X_LOG'] } }))
      .toBe('Procedure that empties and reloads X_FLAGS, reading encounters. It runs usp_X_LOG.');
    expect(draftDescription({ kind: 'procedure', name: 'dbo.p', encrypted: true, analysis: { writes: [], reads: [], calls: [] } })).toContain('encrypts');
    expect(draftDescription({ kind: 'table', name: 'dbo.encounters', columns: 5, references: ['dbo.patients'], builtBy: [], readBy: 2 }))
      .toBe('Table encounters with 5 columns, linked by declared keys to patients. Read by 2 objects.');
  });
});

describe('procedure analysis from scrubbed SQL', () => {
  it('reads PostgreSQL functions and ignores commented-out statements', () => {
    const analysis = analyseDefinition({ name: 'public.refresh_x_totals', defaultSchema: 'public', text: `CREATE FUNCTION public.refresh_x_totals() RETURNS void AS $$
BEGIN
  -- <comment>
  DELETE FROM x_totals;
  INSERT INTO public.x_totals SELECT department_id, count(*) FROM public.orders o JOIN public.departments d USING (department_id) GROUP BY department_id;
  PERFORM public.log_run('<string>');
END $$ LANGUAGE plpgsql` });
    expect(analysis.writes).toEqual([{ table: 'public.x_totals', mode: 'insert' }]);
    expect(analysis.reads).toEqual(['public.departments', 'public.orders']);
    expect(analysis.calls).toEqual(['public.log_run']);
    expect(analysis.kind).toBe('fact_loader');
  });
  it('treats an UPDATE target as written and a SELECT-only procedure as a report or check by name', () => {
    expect(analyseDefinition({ name: 'dbo.usp_fix', defaultSchema: 'dbo', text: 'UPDATE dbo.orders SET status = <number> WHERE id IN (SELECT id FROM dbo.bad_orders)' }).writes).toEqual([{ table: 'dbo.orders', mode: 'update' }]);
    expect(analyseDefinition({ name: 'dbo.rpt_daily', defaultSchema: 'dbo', text: 'SELECT * FROM dbo.orders' }).kind).toBe('report');
    expect(analyseDefinition({ name: 'dbo.usp_validate_orders', defaultSchema: 'dbo', text: 'SELECT count(*) FROM dbo.orders' }).kind).toBe('data_check');
  });
});

describe('interactive HTML export template (spec 2.5)', () => {
  const html = renderDictionaryHtml({ generatedAt: '2026-11-25T10:00:00.000Z', sources: [{
    name: 'Source </script><script>alert(1)</script>', type: 'sql_server',
    objects: [{ name: 'dbo.patients', kind: 'table', custom: false, group: 'Tables', description: null, columns: [
      { name: 'mrn', label: null, dataType: 'nvarchar', tags: ['personal'], statsWithheld: true, nullRate: null, distinctCount: null, description: null },
      { name: 'patient_id', label: null, dataType: 'int', tags: [], statsWithheld: false, nullRate: 0, distinctCount: 3, description: null }] }],
    relationships: [], outOfScope: [{ name: 'dbo.BH_NOTES', type: 'table' }] }] });
  it('is one file that forbids every network request and loads nothing external', () => {
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"`);
    expect(html).not.toMatch(/<(?:script|link|img|iframe)[^>]+(?:src|href)=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });
  it('cannot be broken out of by names, and lists out-of-scope objects by name and type only', () => {
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(scriptJson('</script><!--\u2028')).toBe('"\\u003c/script\\u003e\\u003c!--\\u2028"');
    expect(html).toContain('dbo.BH_NOTES · table');
    expect(html.split('dbo.BH_NOTES')).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import { draftDescription, groupFor, hasCustomPrefix, isCustom, sqlSnippets } from '@scaleinsyght/api/dictionary';
import { renderDictionaryHtml, scriptJson } from '@scaleinsyght/api/dictionary-html';
import { analyseDefinition } from '@scaleinsyght/profiler';

describe('Dictionary custom detection (spec 2.1)', () => {
  it('finds the X_ token at the start or after an underscore, on the object name only', () => {
    for (const name of ['dbo.X_READMIT_FLAGS', 'dbo.usp_X_LOAD', 'dbo.rpt_X_BY_DEPT', 'public.x_census', 'X_JOB_LOG']) expect(hasCustomPrefix(name), name).toBe(true);
    for (const name of ['dbo.encounters', 'dbo.max_value', 'dbo.tax_rate', 'X_schema.encounters', 'dbo.idx_patients', 'public.f(x_a integer)']) expect(hasCustomPrefix(name), name).toBe(false);
  });
  it('treats objects missing from an imported vendor dictionary as custom, and never custom for sheets or dbt', () => {
    const imported = new Set(['dbo.patients']);
    expect(isCustom('dbo.patients', 'table', imported)).toBe(false);
    expect(isCustom('dbo.local_extract', 'table', imported)).toBe(true);
    expect(isCustom('dbo.local_extract', 'table', null)).toBe(false);
    expect(isCustom('X_budget', 'sheet', null)).toBe(false);
    expect(isCustom('analytics.stg_orders', 'model', imported)).toBe(false);
    expect(isCustom('Long stay', 'calculated_field', null)).toBe(true);
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

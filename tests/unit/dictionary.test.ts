import { describe, expect, it } from 'vitest';
import { DRAFTED_KINDS, draftDescription, groupFor, originOf, sqlSnippets, type ObjectKind } from '@scaleinsyght/api/dictionary';
import { renderDictionaryHtml, scriptJson } from '@scaleinsyght/api/dictionary-html';
import { analyseDefinition } from '@scaleinsyght/profiler';
import { splitRoutineArguments } from '@scaleinsyght/connectors';
import { dictionaryDocx, dictionaryMarkdown } from '@scaleinsyght/reports';
import JSZip from 'jszip';
import { listTitles, objectTitle } from '../../apps/web/src/dictionary.js';

describe('Standard and Custom by object type (decision 64)', () => {
  it('calls base data Standard and everything built over it Custom, whatever the name or source', () => {
    for (const kind of ['table', 'sheet', 'source', 'datasource'] as ObjectKind[]) expect(originOf(kind), kind).toBe('standard');
    for (const kind of ['view', 'materialized_view', 'procedure', 'function', 'package', 'model', 'worksheet', 'calculated_field'] as ObjectKind[]) expect(originOf(kind), kind).toBe('custom');
  });
  it('drafts descriptions for database objects and sheets, not for dbt or BI objects', () => {
    expect([...DRAFTED_KINDS].sort()).toEqual(['function', 'materialized_view', 'package', 'procedure', 'sheet', 'table', 'view']);
  });
  it('groups procedures by their parsed kind, and every table under Tables', () => {
    expect(groupFor({ kind: 'procedure', procedureKind: 'fact_loader' }).label).toBe('Procedures · Fact loaders');
    expect(groupFor({ kind: 'procedure', procedureKind: null }).label).toBe('Procedures · Utilities');
    expect(groupFor({ kind: 'procedure', procedureKind: 'report' }).label).toBe('Procedures · Report procedures');
    expect(groupFor({ kind: 'view', procedureKind: null }).label).toBe('Views');
    expect(groupFor({ kind: 'table', procedureKind: null }).label).toBe('Tables');
  });
});

describe('routine arguments (decision 64)', () => {
  const arg = (name: string, mode: string) => ({ name, dataType: 'integer', mode });
  it('keeps a function\'s RETURNS TABLE columns and OUT arguments apart from its inputs', () => {
    const split = splitRoutineArguments('function', [arg('p_patient', 'in'), arg('p_from', 'in'), arg('p_to', 'in'), ...Array.from({ length: 13 }, (_, index) => arg(`c${index}`, 'table'))]);
    expect(split.parameters.map((item) => item.name)).toEqual(['p_patient', 'p_from', 'p_to']);
    expect(split.returns).toHaveLength(13);
    expect(splitRoutineArguments('function', [arg('a', 'in'), arg('total', 'out'), arg('both', 'inout')])).toEqual({
      parameters: [{ name: 'a', dataType: 'integer', mode: 'in' }, { name: 'both', dataType: 'integer', mode: 'inout' }], returns: [{ name: 'total', dataType: 'integer' }] });
  });
  it('keeps a procedure\'s OUT arguments as output parameters', () => {
    expect(splitRoutineArguments('procedure', [arg('ward', 'in'), arg('n', 'out')])).toEqual({ parameters: [{ name: 'ward', dataType: 'integer', mode: 'in' }, { name: 'n', dataType: 'integer', mode: 'out' }], returns: [] });
  });
});

describe('Markdown and Word exports carry table descriptions (decision 64)', () => {
  const input = { sourceName: 'Ward source', generatedAt: '2026-11-27', tables: [
    { name: 'dbo.encounters', description: { text: 'Table encounters with 5 columns.', drafted: true }, columns: [{ name: 'dbo.encounters.ward', label: null, dataType: 'text', tags: [], nullRate: 0, distinctCount: 4, description: 'Ward code' }] },
    { name: 'dbo.wards', description: { text: 'One row per ward.', drafted: false }, columns: [] },
    { name: 'dbo.beds', description: null, columns: [] }] };
  it('marks drafted descriptions "Drafted", as the product and the HTML export do', async () => {
    const markdown = dictionaryMarkdown(input);
    expect(markdown).toContain('## dbo.encounters\n\n**Drafted:** Table encounters with 5 columns.\n');
    expect(markdown).toContain('## dbo.wards\n\nOne row per ward.\n');
    expect(markdown).toContain('| Ward code |');
    const document = await (await JSZip.loadAsync(await dictionaryDocx(input))).file('word/document.xml')!.async('string');
    expect(document).toContain('Drafted: Table encounters with 5 columns.');
    expect(document).toContain('>One row per ward.<');
    expect(document).not.toContain('Drafted: One row per ward.');
  });
});

describe('object titles (decision 64)', () => {
  it('shows the own name, without schema or argument list', () => {
    expect(objectTitle('public.e02_a1c(p_patient integer, p_from date, p_to date)')).toBe('e02_a1c');
    expect(objectTitle('emr.e02_a1c()')).toBe('e02_a1c');
    expect(objectTitle('dbo.X_READMIT_FLAGS')).toBe('X_READMIT_FLAGS');
    expect(objectTitle('Long stay')).toBe('Long stay');
  });
  it('adds the schema or arguments only where two names would look the same', () => {
    const titles = listTitles(['public.f(a integer)', 'public.f(a text)', 'emr.g()', 'audit.g()', 'public.h()']);
    expect(titles.get('public.f(a integer)')).toEqual({ title: 'f', hint: '(a integer)' });
    expect(titles.get('emr.g()')).toEqual({ title: 'g', hint: 'emr ()' });
    expect(titles.get('public.h()')).toEqual({ title: 'h', hint: null });
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

import { describe, expect, it } from 'vitest';
import { applyRequest, chooseForm, planSummary, recogniseFormRequest, refusalCopy, toRows, type Previous } from '../../apps/web/src/home-answer.js';

// Decision 56: the display rule and form-only follow-ups, decided in code.
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ group_value: `G${index + 1}`, value: 100 - index }));

describe('display rule (decision 56, section 2)', () => {
  it('chooses sentence, small table, chart or compact table from the number of groups', () => {
    expect(chooseForm({})).toBe('sentence');
    expect(chooseForm({ rows: rows(1) })).toBe('sentence');
    expect(chooseForm({ rows: rows(2) })).toBe('small_table');
    expect(chooseForm({ rows: rows(5) })).toBe('small_table');
    expect(chooseForm({ rows: rows(6) })).toBe('chart');
    expect(chooseForm({ rows: rows(20) })).toBe('chart');
    expect(chooseForm({ rows: rows(21) })).toBe('compact_table');
    expect(chooseForm({ rows: rows(3), lineage: { nodes: [] } })).toBe('lineage');
  });
  it('keeps withheld cells as withheld and never re-sorts unless asked', () => {
    const shaped = toRows([{ group_value: 'A', value: '<11' }, { group_value: 'B', value: '12' }]);
    expect(shaped).toEqual([{ label: 'A', key: '', value: '<11' }, { label: 'B', key: '', value: 12 }]);
    expect(applyRequest(shaped, null).rows.map((row) => row.label)).toEqual(['A', 'B']);
    expect(applyRequest(shaped, { form: 'sort_value' }).rows.map((row) => row.label)).toEqual(['B', 'A']);
    expect(applyRequest(toRows(rows(8)), { form: 'top', size: 3 }).rows.map((row) => row.label)).toEqual(['G1', 'G2', 'G3']);
    expect(applyRequest(toRows(rows(8)), { form: 'bottom', size: 2 }).rows.map((row) => row.label)).toEqual(['G7', 'G8']);
  });
  it('summarises a finished plan in one line', () => {
    expect(planSummary({ state: 'COMPLETED', sources: ['SQL Server'], steps: 1, startedAt: '2026-11-25T10:00:00Z', endedAt: '2026-11-25T10:00:08Z' })).toBe('Answered from SQL Server · 1 query · 8 s');
    expect(planSummary({ state: 'COMPLETED', sources: ['A', 'B', 'A'], steps: 3 })).toBe('Answered from 2 sources · 3 queries');
    expect(planSummary({ state: 'FAILED', sources: [], steps: 0, reasonText: 'excluded in Controls' })).toBe('Not answered · excluded in Controls');
  });
  it('explains every refusal with a safe next step', () => {
    expect(refusalCopy('object_out_of_scope', ['public.patients']).explanation).toBe('public.patients is excluded in Controls, so it was not queried. An admin can change this in Controls.');
    expect(refusalCopy('analytic_sensitive_column', undefined).alternative?.kind).toBe('ask');
    expect(refusalCopy('something_new', undefined).explanation).toBe('I couldn’t answer this question from the selected sources.');
  });
});

describe('form-only follow-ups (decision 56, addition b)', () => {
  const grouped: Previous = { scalar: false, rowCount: 12, order: 'desc', complete: true };
  const scalar: Previous = { scalar: true, rowCount: 0, order: null, complete: true };
  const accepted: Array<[string, Previous, unknown]> = [
    ['show that as a table', grouped, { form: 'table' }],
    ['can you put that in a table', grouped, { form: 'table' }],
    ['table please', grouped, { form: 'table' }],
    ['Table.', grouped, { form: 'table' }],
    ['could you show it as a table instead?', grouped, { form: 'table' }],
    ['as a chart', grouped, { form: 'chart' }],
    ['bar chart please', grouped, { form: 'chart' }],
    ['can I see that as a graph', grouped, { form: 'chart' }],
    ['show all', grouped, { form: 'all' }],
    ['show me everything', grouped, { form: 'all' }],
    ['all rows please', grouped, { form: 'all' }],
    ['just give me the number', scalar, { form: 'number' }],
    ['just the number', scalar, { form: 'number' }],
    ['top 3', grouped, { form: 'top', size: 3 }],
    ['show the top five', grouped, { form: 'top', size: 5 }],
    ['lowest 2', grouped, { form: 'bottom', size: 2 }],
    ['sort by name', grouped, { form: 'sort_name' }],
    ['alphabetically please', grouped, { form: 'sort_name' }],
    ['sorted by value', grouped, { form: 'sort_value' }],
    ['largest first', grouped, { form: 'sort_value' }],
  ];
  for (const [text, previous, expected] of accepted) it(`accepts "${text}"`, () => expect(recogniseFormRequest(text, previous)).toEqual(expected));

  const rejected: Array<[string, Previous]> = [
    ['and how many of them were cancelled?', grouped],
    ['how many orders are there in total?', grouped],
    ['show that as a table by department', grouped],
    ['table of patients', grouped],
    ['show me the patients table', grouped],
    ['chart of revenue by month', grouped],
    ['what about the PostgreSQL testbed?', grouped],
    ['list the patients', grouped],
    ['just give me the number', grouped],
    ['show as a table', scalar],
    ['top 20', grouped],
    ['top 3', { ...grouped, complete: false }],
    ['top 3', { ...grouped, order: null }],
    ['total', grouped],
    ['show all', null],
    ['average instead', grouped],
  ];
  for (const [text, previous] of rejected) it(`runs "${text}" normally`, () => expect(recogniseFormRequest(text, previous)).toBeNull());
});

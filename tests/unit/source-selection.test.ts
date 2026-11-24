import { describe, expect, it } from 'vitest';
import { referencedTables, selectSources, type CandidateSource } from '@scaleinsyght/api/source-selection';

const source = (sourceId: string, name: string, connectorType: string, tables: Record<string, string[]>): CandidateSource => ({ sourceId, name, connectorType, tables: new Map(Object.entries(tables).map(([table, columns]) => [table, new Set(columns)])) });
const hospital = { encounters: ['encounter_id', 'department_id', 'admitted_at'], departments: ['department_id', 'department_name'], patients: ['patient_id', 'phone'] };
const first = source('a', 'SQL Server hospital', 'sql_server', hospital);
const second = source('b', 'PostgreSQL testbed', 'postgres', hospital);
const workbook = source('c', 'Budget workbook', 'excel', { budget: ['line', 'amount'] });
const emergency = { kind: 'join_aggregate', leftTable: 'dbo.encounters', rightTable: 'dbo.departments', leftColumn: 'department_id', rightColumn: 'department_id', aggregate: { operation: 'count' }, filters: [{ table: 'dbo.departments', column: 'department_name', operator: 'eq', value: 'Emergency' }, { table: 'dbo.encounters', column: 'admitted_at', operator: 'gte', value: '2025-01-01' }] };

describe('source selection for answers', () => {
  it('source_selection_asks_when_an_unnamed_question_fits_more_than_one_selected_source', () => {
    expect(selectSources({ question: 'How many encounters were emergency visits in 2025?', context: '', candidates: [first, second], selected: [first], intents: [emergency] }))
      .toEqual({ kind: 'ask', options: [{ sourceId: 'a', name: 'SQL Server hospital' }, { sourceId: 'b', name: 'PostgreSQL testbed' }] });
  });
  it('source_selection_explains_a_named_source_and_the_source_left_out', () => {
    expect(selectSources({ question: 'How many emergency visits in SQL Server hospital in 2025?', context: '', candidates: [first, second], selected: [first], intents: [emergency] }))
      .toEqual({ kind: 'answer', used: [{ sourceId: 'a', name: 'SQL Server hospital', reason: 'named in your question' }], unused: [{ sourceId: 'b', name: 'PostgreSQL testbed', reason: 'not named in your question' }] });
  });
  it('source_selection_explains_why_a_source_without_the_tables_was_not_used', () => {
    expect(selectSources({ question: 'How many emergency visits in 2025?', context: '', candidates: [first, workbook], selected: [first], intents: [emergency] }))
      .toEqual({ kind: 'answer', used: [{ sourceId: 'a', name: 'SQL Server hospital', reason: 'the only selected source with the tables this question needs' }], unused: [{ sourceId: 'c', name: 'Budget workbook', reason: 'does not have the tables this question needs' }] });
  });
  it('source_selection_keeps_conversation_scope_and_compares_when_both_are_queried', () => {
    const phone = { kind: 'filtered_count', table: 'public.patients', column: 'phone', operator: 'is_not_null' };
    expect(selectSources({ question: 'and how many of them have a phone number?', context: 'user: How many patients in SQL Server hospital?', candidates: [first, second], selected: [first], intents: [phone] })).toMatchObject({ kind: 'answer', used: [{ reason: 'used earlier in this conversation' }] });
    expect(selectSources({ question: 'Do the two testbeds have the same number of patients?', context: '', candidates: [first, second], selected: [first, second], intents: [phone, phone] })).toMatchObject({ kind: 'answer', used: [{ reason: 'each selected source was queried' }, { reason: 'each selected source was queried' }], unused: [] });
  });
  it('source_selection_reads_tables_and_columns_from_typed_intents', () => {
    expect([...referencedTables(emergency).entries()].map(([table, columns]) => [table, [...columns].sort()])).toEqual([['encounters', ['admitted_at', 'department_id']], ['departments', ['department_id', 'department_name']]]);
  });
});

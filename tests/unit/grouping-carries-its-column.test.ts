import Ajv from 'ajv';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { plannerSchema } from '../../apps/api/src/structured-planner.js';
import { planLiveQuestion } from '../../apps/api/src/live-planner.js';

/**
 * Decision 70: a declared grouping carries its catalog column, so "a grouping with no exposed column" (S2's first-call
 * failure, declared_grouping_without_exposed_column) cannot be expressed. Decision 65's re-ask stays as the backstop.
 * Generic fixture: orders and departments in one SQL Server source.
 */
const { query, complete } = vi.hoisted(() => ({ query: vi.fn(), complete: vi.fn() }));
vi.mock('@scaleinsyght/db', () => ({ withTenant: (_pool: object, _tenant: string, read: (client: { query: typeof query }) => unknown) => read({ query }) }));
vi.mock('@scaleinsyght/model-gateway', () => ({ OpenAIModelGateway: class { complete = complete; } }));

const catalog = [{ name: 'SQL Server hospital', assets: [
  { qualified_name: 'dbo.orders', columns: [{ name: 'order_id' }, { name: 'department_id' }] },
  { qualified_name: 'dbo.departments', columns: [{ name: 'department_id' }, { name: 'department_name' }] },
] }];
const step = { source_index: 0, kind: 'grouped_join', table: 'dbo.orders', join: 'dbo.orders.department_id = dbo.departments.department_id', groupBy: 'dbo.departments.department_name', groupKey: 'dbo.departments.department_id',
  entityColumn: null, operation: 'count', aggregateColumn: null, order: 'desc', limit: null, filters: [],
  declared: { subject_table: 'dbo.orders', measure: 'count', measure_column: null, grouping_column: 'dbo.departments.department_name', filter_columns: [] } };
const read = ['dbo.orders.department_id', 'dbo.departments.department_id', 'dbo.departments.department_name'];
const response = (grouping: unknown, exposed: string[]) => ({ privacy_refusal: null, lineage: null, intents: [step],
  declaration: { subject: 'orders', grouping, conditions: [], comparison: false, every_group: true, answerable: true, exposed_columns: exposed, read_columns: read } });
// CONSTRUCTED, not recorded: the shape of S2's first-call failure, written by hand from the error it raised
// (declared_grouping_without_exposed_column): a free-text grouping and no exposed column.
const CONSTRUCTED_FAILING_FIRST_CALL = response('department', []);

describe('a declared grouping carries its catalog column (decision 70)', () => {
  const validate = new Ajv({ strict: false }).compile(plannerSchema(catalog, []) as object);

  // Schema checks are about the declaration, so the intents list is empty: only the grouping can make them fail.
  const declarationOnly = (value: ReturnType<typeof response>) => ({ ...value, intents: [] });

  it('the schema no longer accepts the old shape', () => {
    expect(validate(declarationOnly(CONSTRUCTED_FAILING_FIRST_CALL))).toBe(false);
    expect(validate.errors?.every((error) => error.instancePath.startsWith('/declaration/grouping'))).toBe(true);
    expect(validate(declarationOnly(response({ label: 'department' }, [])))).toBe(false); // a grouping without its column
    expect(validate(declarationOnly(response({ label: 'department', column: 'dbo.departments.not_a_column' }, [])))).toBe(false); // outside the catalog
  });

  it('the schema accepts a grouping with its column, and no grouping at all', () => {
    expect(validate(declarationOnly(response({ label: 'department', column: 'dbo.departments.department_name' }, [])))).toBe(true);
    expect(validate(declarationOnly(response(null, [])))).toBe(true);
  });

  describe('S2: orders per department plans in one call', () => {
    beforeEach(() => {
      query.mockReset(); complete.mockReset();
      query.mockResolvedValue({ rows: [] });
      query.mockResolvedValueOnce({ rows: [{ source_id: 'source', assets: catalog[0]!.assets.map((asset) => ({ ...asset, columns: asset.columns.map((column) => ({ ...column, data_type: 'int', sensitivity_tags: [] })) })) }] });
      query.mockResolvedValueOnce({ rows: [{ source_index: 0, from_name: 'dbo.orders.department_id', to_name: 'dbo.departments.department_id', evidence_method: 'declared', confidence_score: 1 }] });
    });
    const plan = () => planLiveQuestion({} as Pool, 'tenant', 'How many orders does each department have?', [
      { source_id: 'source', agent_id: 'agent', group_id: 'group', group_version: 1, display_name: 'SQL Server hospital', connector_type: 'sql_server' }], []);
    const verified = { model: 'verifier', inputTokens: 1, outputTokens: 1, text: JSON.stringify({ answers_question: true, reason: 'counts orders per department' }) };

    it('a grouping that names its column but leaves exposed_columns empty is accepted on the first call', async () => {
      complete.mockResolvedValueOnce({ model: 'planner', inputTokens: 1, outputTokens: 1, text: JSON.stringify(response({ label: 'department', column: 'dbo.departments.department_name' }, [])) });
      complete.mockResolvedValueOnce(verified);
      const result = await plan();
      expect(result.kind).toBe('planned');
      expect(complete.mock.calls.map((call) => call[0].purpose)).toEqual(['plan', 'verify']);
    });

    it('the constructed old shape still gets the decision 65 re-ask, as a backstop', async () => {
      complete.mockResolvedValueOnce({ model: 'planner', inputTokens: 1, outputTokens: 1, text: JSON.stringify(CONSTRUCTED_FAILING_FIRST_CALL) });
      complete.mockResolvedValueOnce({ model: 'planner', inputTokens: 1, outputTokens: 1, text: JSON.stringify(response({ label: 'department', column: 'dbo.departments.department_name' }, [])) });
      complete.mockResolvedValueOnce(verified);
      expect((await plan()).kind).toBe('planned');
      expect(complete.mock.calls[1]![0].question).toContain('declared_grouping_without_exposed_column');
    });
  });
});

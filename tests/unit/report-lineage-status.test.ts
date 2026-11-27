import { describe, expect, it } from 'vitest';
import { reportLineageStatus } from '@scaleinsyght/graph';

// Rule 7: a path with an open gap is never shown as complete; inferred links not yet accepted are probable.
const edge = { relationship_id: '00000000-0000-4000-8000-000000000001', from_asset_id: '00000000-0000-4000-8000-000000000002', to_asset_id: '00000000-0000-4000-8000-000000000003', granularity: 'field' as const };
const assertion = (evidence_method: string, review_status: string) => ({ evidence_method, review_status }) as never;
const gap = (closed: string | null) => ({ closed_by_assertion_id: closed }) as never;

describe('report lineage status', () => {
  it('none, gap, probable and complete, in that order of precedence', () => {
    expect(reportLineageStatus({ edges: [], gaps: [], assertions: [] }).status).toBe('none');
    expect(reportLineageStatus({ edges: [edge], gaps: [gap(null)], assertions: [assertion('inferred', 'unreviewed')] })).toEqual({ status: 'gap', gaps: 1, probable: 1 });
    expect(reportLineageStatus({ edges: [edge], gaps: [], assertions: [assertion('inferred', 'disputed'), assertion('declared', 'unreviewed')] })).toEqual({ status: 'probable', gaps: 0, probable: 1 });
    expect(reportLineageStatus({ edges: [edge], gaps: [gap('00000000-0000-4000-8000-000000000009')], assertions: [assertion('inferred', 'accepted'), assertion('parsed', 'unreviewed')] })).toEqual({ status: 'complete', gaps: 0, probable: 0 });
  });
});

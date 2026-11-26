import { describe, expect, it } from 'vitest';
import { impactSummary, type Impact } from '../../apps/web/src/lineage-graph.js';

// "Show impact" in the lineage detail panel replaces the old Impact tab: what depends on a table or column downstream.
const asset = (id: string, name: string, type: string, active = true) => ({ asset_id: id, qualified_name: name, asset_type: type, active });
const names = (summary: ReturnType<typeof impactSummary>) => Object.fromEntries(summary.groups.map((group) => [group.label, group.assets.map((item) => item.qualified_name)]));

describe('lineage impact summary', () => {
  it('lists downstream objects by kind, counts each report once and never lists the selected object or a system', () => {
    const impact: Impact = {
      path: { asset_ids: [], gaps: [], assets: [asset('a0', 'public.orders', 'dataset'), asset('a1', 'analytics.mart_department_orders', 'dataset'), asset('a2', 'analytics.mart_department_orders.order_count', 'field'), asset('r1', 'Orders report', 'report'), asset('s1', 'PostgreSQL', 'system')] },
      reports: [{ asset_id: 'r1', name: 'Orders report', tool: 'power_bi', safe_path: 'https://reports.example/orders' }],
    };
    const summary = impactSummary('a0', impact);
    expect(summary.headline).toBe('3 objects depend on it downstream.');
    expect(names(summary)).toEqual({ 'Tables and views': ['analytics.mart_department_orders'], Columns: ['analytics.mart_department_orders.order_count'] });
    expect(summary.reports.map((report) => report.name)).toEqual(['Orders report']);
    expect(summary.gapNote).toBeNull();
  });
  it('says the impact may be wider when a link on the path is missing, with the reason', () => {
    const summary = impactSummary('a0', { path: { asset_ids: [], assets: [asset('a1', 'analytics.old_mart', 'dataset', false)], gaps: [{ gap_id: 'g1', reason: 'billing.claims is not exposed to any connected source.' }, { gap_id: 'g2' }] }, reports: [] });
    expect(summary.gapNote).toBe('2 links on this path are missing, so the impact may be wider than shown.');
    expect(summary.gapReasons).toEqual(['billing.claims is not exposed to any connected source.']);
    expect(summary.groups[0]!.assets[0]!.active).toBe(false);
  });
  it('says plainly when nothing depends on it', () => {
    expect(impactSummary('a0', { path: { asset_ids: [], assets: [asset('a0', 'public.orders', 'dataset')], gaps: [] }, reports: [] }).headline).toBe('Nothing downstream depends on it in the connected sources.');
  });
});

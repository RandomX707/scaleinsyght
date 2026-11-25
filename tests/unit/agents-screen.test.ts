import { expect, it } from 'vitest';
import { governedRows } from '../../apps/web/src/agents.js';

it('shows each governed agent once, by its latest version, with the version that may run', () => {
  const rows = governedRows([
    { governedId: 'a', name: 'Weekly pack', version: 1, approvedBy: 'u1', lastRunAt: '2026-11-24T07:00:00Z' },
    { governedId: 'a', name: 'Weekly pack', version: 2, approvedBy: null, lastRunAt: '2026-11-24T07:00:00Z' },
    { governedId: 'b', name: 'Nightly check', version: 1, approvedBy: 'u2', lastRunAt: null },
  ]);
  expect(rows.map((row) => [row.name, row.version, row.pending, row.approvedVersion])).toEqual([['Weekly pack', 2, true, 1], ['Nightly check', 1, false, 1]]);
});

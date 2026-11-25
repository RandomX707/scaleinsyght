import { expect, it } from 'vitest';
import { lineageEdgePath } from '../../apps/web/src/lineage-graph.js';

it('routes adjacent lanes through their shared gutter', () => {
  expect(lineageEdgePath(24, 100, 324, 160)).toBe('M294 100 H304 V160 H322');
});
it('crosses skipped lanes above their cards', () => {
  expect(lineageEdgePath(24, 100, 624, 160)).toBe('M294 100 H304 V40 H614 V160 H622');
});

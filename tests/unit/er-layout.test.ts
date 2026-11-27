import { expect, it } from 'vitest';
import { ER_NODE, layoutErGrid, orderColumns } from '../../apps/web/src/er-layout.js';

const table = (name: string, count: number) => ({ name, columns: Array.from({ length: count }, (_, index) => `${name}.c${index}`) });

it('lays tables out three across with the focus first, rows as tall as their tallest table', () => {
  const grid = layoutErGrid([table('s.b', 3), table('s.focus', 2), table('s.c', 9), table('s.d', 1)], [], 's.focus');
  expect(grid.nodes.map((node) => [node.name, node.column])).toEqual([['s.focus', 0], ['s.b', 1], ['s.c', 2], ['s.d', 0]]);
  expect(new Set(grid.nodes.slice(0, 3).map((node) => node.y)).size).toBe(1);
  expect(grid.nodes[3]!.y).toBe(grid.nodes[0]!.y + Math.max(...grid.nodes.slice(0, 3).map((node) => node.height)) + ER_NODE.gapY);
  expect(grid.nodes.find((node) => node.name === 's.c')).toMatchObject({ hidden: 3 });
});

it('draws each link from the source column row to the target column row, linked columns shown first', () => {
  expect(orderColumns(['a', 'b', 'c'], new Set(['c']))).toEqual(['c', 'a', 'b']);
  const grid = layoutErGrid([table('s.orders', 9), table('s.customers', 2)], [{ key: 'k', fromTable: 's.orders', fromColumn: 's.orders.c8', toTable: 's.customers', toColumn: 's.customers.c0' }], 's.orders');
  const [orders, customers] = grid.nodes;
  expect(orders!.shown[0]).toBe('s.orders.c8');
  const rowY = (top: number, index: number) => top + ER_NODE.header + ER_NODE.tags + ER_NODE.listTop + index * ER_NODE.row + ER_NODE.row / 2;
  expect(grid.paths[0]).toMatchObject({ index: 0, d: `M${orders!.x + ER_NODE.width},${rowY(orders!.y, 0)} H${orders!.x + ER_NODE.width + ER_NODE.gapX / 2 - 14} V${rowY(customers!.y, 0)} H${customers!.x}` });
});

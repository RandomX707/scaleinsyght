/**
 * ER explorer grid (prototype V.explorer): tables in a grid, up to three across, the focus table first, and each link
 * drawn as an orthogonal path from the source column's row to the target column's row. Geometry is fixed here and the
 * CSS gives nodes the same heights, so a link always meets the row of the column it joins.
 */
export const ER_NODE = { width: 260, header: 34, tags: 28, listTop: 4, row: 22, shown: 6, more: 18, footer: 76, gapX: 96, gapY: 40, perRow: 3, margin: 24, gutter: 56 };

export type ErGridTable = { name: string; columns: string[] };
export type ErGridLink = { key: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string };
export type ErGridNode = { name: string; x: number; y: number; height: number; shown: string[]; hidden: number; column: number };
export type ErGrid = { nodes: ErGridNode[]; paths: Array<{ key: string; index: number; d: string; labelX: number; labelY: number }>; width: number; height: number };

/** Linked columns first, in their own order, so every link meets a row that is drawn. */
export function orderColumns(columns: string[], linked: Set<string>): string[] {
  return [...columns.filter((column) => linked.has(column)), ...columns.filter((column) => !linked.has(column))];
}

export function layoutErGrid(tables: ErGridTable[], links: ErGridLink[], focus: string): ErGrid {
  const W = ER_NODE.width;
  const ordered = [...tables].sort((a, b) => Number(b.name === focus) - Number(a.name === focus) || a.name.localeCompare(b.name));
  const perRow = Math.max(1, Math.min(ER_NODE.perRow, ordered.length));
  const linked = new Set(links.flatMap((link) => [link.fromColumn, link.toColumn]));
  const sized = ordered.map((table) => {
    const columns = orderColumns(table.columns, linked);
    const shown = columns.slice(0, Math.max(ER_NODE.shown, columns.filter((column) => linked.has(column)).length));
    const hidden = columns.length - shown.length;
    return { table, shown, hidden, height: ER_NODE.header + ER_NODE.tags + ER_NODE.listTop + shown.length * ER_NODE.row + (hidden ? ER_NODE.more : 0) + ER_NODE.footer };
  });
  const nodes: ErGridNode[] = []; let top = ER_NODE.margin;
  for (let start = 0; start < sized.length; start += perRow) {
    const row = sized.slice(start, start + perRow); const height = Math.max(...row.map((item) => item.height));
    row.forEach((item, index) => nodes.push({ name: item.table.name, x: ER_NODE.margin + index * (W + ER_NODE.gapX), y: top, height: item.height, shown: item.shown, hidden: item.hidden, column: index }));
    top += height + ER_NODE.gapY;
  }
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const anchor = (node: ErGridNode, column: string) => {
    const index = node.shown.indexOf(column);
    return index < 0 ? node.y + ER_NODE.header / 2 : node.y + ER_NODE.header + ER_NODE.tags + ER_NODE.listTop + index * ER_NODE.row + ER_NODE.row / 2;
  };
  const paths = links.flatMap((link, index) => {
    const from = byName.get(link.fromTable); const to = byName.get(link.toTable);
    if (!from || !to) return [];
    const sy = anchor(from, link.fromColumn); const ty = anchor(to, link.toColumn);
    // Spread parallel links a little so they do not draw on top of each other.
    const lane = (index % 5) * 7 - 14;
    let sx: number, tx: number, mid: number;
    if (from.column < to.column) { sx = from.x + W; tx = to.x; mid = sx + ER_NODE.gapX / 2 + lane; }
    else if (from.column > to.column) { sx = from.x; tx = to.x + W; mid = sx - ER_NODE.gapX / 2 + lane; }
    else { sx = from.x + W; tx = to.x + W; mid = from.x + W + ER_NODE.gutter / 2 + lane; }
    return [{ key: link.key, index, d: `M${sx},${sy} H${mid} V${ty} H${tx}`, labelX: mid + 4, labelY: (sy + ty) / 2 - 4 }];
  });
  const columns = Math.min(perRow, nodes.length);
  return { nodes, paths, width: ER_NODE.margin * 2 + columns * W + (columns - 1) * ER_NODE.gapX + ER_NODE.gutter, height: Math.max(320, top - ER_NODE.gapY + ER_NODE.margin) };
}

import React, { useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Input, Table } from '@scaleinsyght/ui';

type Method = 'declared' | 'parsed' | 'observed' | 'inferred';
type Edge = { relationshipId: string; from: string; to: string; methods: Method[]; method: Method; reviewStatus: string; verification: string; evidenceCount: number; explanations: string[]; transformation: string | null; collectors: string[] };
export type LineageGraphData = {
  datasets: Array<{ assetId: string; name: string; sourceId: string; sourceName: string; connectorType: string; objectType: string | null }>;
  fields: Array<{ assetId: string; datasetId: string; name: string; dataType: string | null }>;
  tableEdges: Edge[]; columnEdges: Edge[]; gaps: Array<{ gapId: string; assetId: string; reason: string }>;
};
type Filter = Method | 'gap';

/** Evidence colours are fixed everywhere (CLAUDE.md section 11). */
const EVIDENCE: Record<Filter, { label: string; color: string; dash: string }> = {
  declared: { label: 'Declared', color: '#15803D', dash: '' }, parsed: { label: 'Parsed', color: '#0369A1', dash: '' },
  observed: { label: 'Observed', color: '#6D28D9', dash: '' }, inferred: { label: 'Inferred', color: '#CA8A04', dash: '7 5' },
  gap: { label: 'Missing', color: '#B91C1C', dash: '2 5' },
};
const LANE_X = 24; const LANE_W = 300; const NODE_W = 270; const HEAD = 30; const ROW = 22; const TOP = 48;
const connectorLabel: Record<string, string> = { postgres: 'PostgreSQL', sql_server: 'SQL Server', excel: 'Excel', dbt: 'dbt', snowflake: 'Snowflake', tableau: 'Tableau', power_bi: 'Power BI' };

const shortType = (type: string | null) => !type ? '' : type.length > 14 ? `${type.slice(0, 13)}…` : type;
function curve(x1: number, y1: number, x2: number, y2: number) {
  const mid = (x2 - x1) / 2;
  return `M${x1} ${y1} C${x1 + mid} ${y1},${x2 - mid} ${y2},${x2} ${y2}`;
}

export function lineageEdgePath(fromX: number, fromY: number, toX: number, toY: number) {
  const start = fromX + NODE_W;
  const end = toX - 2;
  const exit = start + 10;
  // Each lane has a clear gutter on either side of its cards. Use the header
  // gutter to cross intervening lanes, including cycles that return to a lane.
  if (toX - fromX === LANE_W) return `M${start} ${fromY} H${exit} V${toY} H${end}`;
  return `M${start} ${fromY} H${exit} V40 H${toX - 10} V${toY} H${end}`;
}
function closure(start: string, edges: Edge[]) {
  const up = new Set<string>(); const down = new Set<string>(); const used = new Set<Edge>();
  const walk = (id: string, direction: 'up' | 'down', seen: Set<string>) => {
    for (const edge of edges) {
      const next = direction === 'up' ? (edge.to === id ? edge.from : null) : (edge.from === id ? edge.to : null);
      if (!next) continue; used.add(edge);
      if (!seen.has(next)) { seen.add(next); walk(next, direction, seen); }
    }
  };
  walk(start, 'up', up); walk(start, 'down', down);
  return { up, down, nodes: new Set([start, ...up, ...down]), edges: used };
}

export function LineageGraph(props: { data: LineageGraphData; onAsk: (question: string) => void; onOpenDictionary: (sourceId: string) => void }) {
  const { data } = props;
  const [off, setOff] = useState<Partial<Record<Filter, boolean>>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [column, setColumn] = useState<string | null>(null);
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [query, setQuery] = useState(''); const [find, setFind] = useState('');

  const layout = useMemo(() => {
    const lane = new Map<string, number>();
    const depth = (id: string, seen: Set<string>): number => {
      if (lane.has(id)) return lane.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const inputs = data.tableEdges.filter((edge) => edge.to === id);
      const value = inputs.length ? Math.max(...inputs.map((edge) => depth(edge.from, seen) + 1)) : 0;
      lane.set(id, value); return value;
    };
    for (const dataset of data.datasets) depth(dataset.assetId, new Set());
    const lanes = Math.max(0, ...lane.values()) + 1;
    const fieldsOf = new Map<string, LineageGraphData['fields']>();
    for (const field of data.fields) fieldsOf.set(field.datasetId, [...(fieldsOf.get(field.datasetId) ?? []), field]);
    for (const list of fieldsOf.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    const nodes = new Map<string, { x: number; y: number; h: number; lane: number; group: string }>();
    const groups: Array<{ x: number; y: number; title: string }> = [];
    let height = TOP;
    for (let index = 0; index < lanes; index++) {
      let y = TOP + 8;
      const inLane = data.datasets.filter((dataset) => lane.get(dataset.assetId) === index).sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.name.localeCompare(b.name));
      let group = '';
      for (const dataset of inLane) {
        const title = `${dataset.sourceName} · ${connectorLabel[dataset.connectorType] ?? dataset.connectorType}`;
        if (title !== group) { group = title; groups.push({ x: LANE_X + index * LANE_W, y, title }); y += 22; }
        const h = HEAD + (open[dataset.assetId] ? (fieldsOf.get(dataset.assetId)?.length ?? 0) * ROW + 8 : 0);
        nodes.set(dataset.assetId, { x: LANE_X + index * LANE_W, y, h, lane: index, group: title }); y += h + 14;
      }
      height = Math.max(height, y + 16);
    }
    return { lane, lanes, nodes, groups, fieldsOf, width: LANE_X + lanes * LANE_W, height };
  }, [data, open]);

  if (!data.datasets.length) return <EmptyState title="No lineage to show yet" description="Profile a database with views, or add a dbt project, to see how data moves between tables. Only lineage backed by declared or parsed evidence is drawn." />;

  const datasetById = new Map(data.datasets.map((dataset) => [dataset.assetId, dataset]));
  const fieldById = new Map(data.fields.map((field) => [field.assetId, field]));
  const gapsFor = (id: string) => data.gaps.filter((gap) => gap.assetId === id);
  const visible = (edge: Edge) => !off[edge.method];
  const tableEdges = data.tableEdges.filter(visible); const columnEdges = data.columnEdges.filter(visible);
  const columnClosure = column ? closure(column, columnEdges) : null;
  const tableClosure = !column && selected ? closure(selected, tableEdges) : null;
  const highlighted = columnClosure ? new Set([...columnClosure.nodes].map((id) => fieldById.get(id)?.datasetId).filter((id): id is string => Boolean(id))) : tableClosure?.nodes ?? null;
  const counts: Record<Filter, number> = { declared: 0, parsed: 0, observed: 0, inferred: 0, gap: data.gaps.length };
  for (const edge of data.tableEdges) counts[edge.method]++;
  const evidenced = counts.declared + counts.parsed + counts.observed;
  const systems = new Set(data.datasets.map((dataset) => dataset.sourceId)).size;
  const unused = data.datasets.filter((dataset) => (layout.lane.get(dataset.assetId) ?? 0) < layout.lanes - 1 && !data.tableEdges.some((edge) => edge.from === dataset.assetId)).length;
  const rowY = (fieldId: string) => { const field = fieldById.get(fieldId)!; const node = layout.nodes.get(field.datasetId)!; const index = layout.fieldsOf.get(field.datasetId)!.findIndex((item) => item.assetId === fieldId); return node.y + HEAD + index * ROW + ROW / 2 + 2; };
  const label = (id: string) => { const field = fieldById.get(id); if (field) return `${datasetById.get(field.datasetId)?.name ?? ''}.${field.name}`; return datasetById.get(id)?.name ?? 'Unknown'; };
  const methodChip = (method: Filter) => <span className="lineage-method" style={{ color: EVIDENCE[method].color, background: `${EVIDENCE[method].color}1a` }}>{EVIDENCE[method].label}</span>;
  const chooseTable = (id: string) => { setColumn(null); setEdgeId(null); if (selected === id && open[id]) { setOpen({ ...open, [id]: false }); } else { setOpen({ ...open, [id]: true }); setSelected(id); } };
  const chooseColumn = (id: string) => {
    const reach = closure(id, columnEdges);
    const expand = { ...open }; for (const fieldId of reach.nodes) { const datasetId = fieldById.get(fieldId)?.datasetId; if (datasetId) expand[datasetId] = true; }
    setOpen(expand); setColumn(id); setSelected(null); setEdgeId(null);
  };
  const clear = () => { setSelected(null); setColumn(null); setEdgeId(null); setFind(''); setQuery(''); };
  const firstGap = data.gaps.find((gap) => fieldById.has(gap.assetId)) ?? data.gaps[0];
  const deepest = [...data.fields].sort((a, b) => (layout.lane.get(b.datasetId) ?? 0) - (layout.lane.get(a.datasetId) ?? 0)).find((field) => data.columnEdges.some((edge) => edge.to === field.assetId));
  const edge = edgeId ? [...data.tableEdges, ...data.columnEdges].find((item) => item.relationshipId === edgeId) : undefined;

  const graph = <svg className="lgraph" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Lineage graph of every table and view with evidence-backed links">
    <defs>{(Object.keys(EVIDENCE) as Filter[]).map((key) => <marker key={key} id={`lineage-arrow-${key}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill={EVIDENCE[key].color} /></marker>)}</defs>
    {Array.from({ length: layout.lanes }, (_, index) => <text key={`lane-${index}`} className="lh" x={LANE_X + index * LANE_W} y={30}>{index === 0 ? 'Source tables' : `Built from level ${index}`}</text>)}
    {layout.groups.map((group) => <text key={`${group.x}-${group.y}`} className="gh" x={group.x} y={group.y + 14}>{group.title}</text>)}
    {tableEdges.map((item) => {
      const a = layout.nodes.get(item.from); const b = layout.nodes.get(item.to); if (!a || !b) return null;
      const on = !tableClosure || tableClosure.edges.has(item); const path = lineageEdgePath(a.x, a.y + 15, b.x, b.y + 15); const style = EVIDENCE[item.method];
      return <g key={item.relationshipId} className="ledge" role="button" tabIndex={0} aria-label={`${label(item.from)} to ${label(item.to)}, ${style.label}`} onClick={() => { setEdgeId(item.relationshipId); setColumn(null); }} onKeyDown={(event) => { if (event.key === 'Enter') setEdgeId(item.relationshipId); }}>
        <path d={path} stroke="transparent" strokeWidth={12} fill="none" />
        <path d={path} fill="none" stroke={style.color} strokeDasharray={style.dash} strokeWidth={edgeId === item.relationshipId ? 3.5 : 1.6} opacity={columnClosure ? 0.08 : on ? 1 : 0.12} markerEnd={`url(#lineage-arrow-${item.method})`} />
      </g>;
    })}
    {columnEdges.map((item) => {
      const a = fieldById.get(item.from); const b = fieldById.get(item.to); if (!a || !b || !open[a.datasetId] || !open[b.datasetId]) return null;
      const from = layout.nodes.get(a.datasetId)!; const to = layout.nodes.get(b.datasetId)!; const on = !columnClosure || columnClosure.edges.has(item); const style = EVIDENCE[item.method];
      return <path key={item.relationshipId} d={lineageEdgePath(from.x, rowY(item.from), to.x, rowY(item.to))} fill="none" stroke={style.color} strokeDasharray={style.dash} strokeWidth={columnClosure && on ? 2.4 : 1.1} opacity={columnClosure ? (on ? 1 : 0.08) : 0.55} markerEnd={`url(#lineage-arrow-${item.method})`}><title>{`${label(item.from)} → ${label(item.to)}: ${style.label}`}</title></path>;
    })}
    {data.datasets.map((dataset) => {
      const node = layout.nodes.get(dataset.assetId)!; const on = !highlighted || highlighted.has(dataset.assetId); const match = Boolean(find) && dataset.name.toLowerCase().includes(find.toLowerCase());
      const gaps = off.gap ? [] : gapsFor(dataset.assetId); const columns = layout.fieldsOf.get(dataset.assetId) ?? [];
      const isUnused = (layout.lane.get(dataset.assetId) ?? 0) < layout.lanes - 1 && !data.tableEdges.some((item) => item.from === dataset.assetId);
      const meta = isUnused ? 'unused' : dataset.objectType === 'view' ? 'view' : dataset.connectorType === 'dbt' ? 'dbt model' : '';
      return <g key={dataset.assetId} className="lnode2" opacity={on || match ? 1 : 0.25}>
        {gaps.length > 0 && <path d={`M${node.x - 34} ${node.y + 15} H${node.x - 2}`} stroke={EVIDENCE.gap.color} strokeDasharray={EVIDENCE.gap.dash} strokeWidth={2} markerEnd="url(#lineage-arrow-gap)"><title>{gaps.map((gap) => gap.reason).join('; ')}</title></path>}
        <g role="button" tabIndex={0} aria-expanded={Boolean(open[dataset.assetId])} aria-label={`${dataset.name}, ${open[dataset.assetId] ? 'hide' : 'show'} columns`} onClick={() => chooseTable(dataset.assetId)} onKeyDown={(event) => { if (event.key === 'Enter') chooseTable(dataset.assetId); }}>
          <rect x={node.x} y={node.y} width={NODE_W} height={node.h} rx={7} fill={dataset.objectType === 'view' ? '#EEF0FC' : dataset.connectorType === 'dbt' ? '#FEFCE8' : '#FFFFFF'} stroke={selected === dataset.assetId ? '#5A67D8' : match ? '#EA580C' : '#CBD5E1'} strokeWidth={selected === dataset.assetId || match ? 2.5 : 1} />
          {columns.length > 0 && <path d={open[dataset.assetId] ? `M${node.x + 9} ${node.y + 12} l4 5 l4 -5` : `M${node.x + 10} ${node.y + 10} l5 4 l-5 4`} fill="none" stroke="#64748B" strokeWidth={1.6} strokeLinecap="round" />}
          <svg x={node.x + 24} y={node.y} width={NODE_W - (meta ? 96 : 32)} height={HEAD} overflow="hidden">
            <text className="nl" x={0} y={19}>{dataset.name}<title>{dataset.name}</title></text>
          </svg>
          {meta && <text className="nm" x={node.x + NODE_W - 8} y={node.y + 19} textAnchor="end" style={isUnused ? { fill: '#B91C1C' } : undefined}>{meta}</text>}
        </g>
        {open[dataset.assetId] && columns.map((field, index) => {
          const y = node.y + HEAD + index * ROW + 2; const inPath = columnClosure?.nodes.has(field.assetId); const isSelected = column === field.assetId; const gap = !off.gap && gapsFor(field.assetId).length > 0;
          return <g key={field.assetId} className="lcol" role="button" tabIndex={0} aria-label={`Column ${dataset.name}.${field.name}`} onClick={(event) => { event.stopPropagation(); chooseColumn(field.assetId); }} onKeyDown={(event) => { if (event.key === 'Enter') chooseColumn(field.assetId); }}>
            <rect x={node.x + 6} y={y} width={NODE_W - 12} height={ROW - 2} rx={5} fill={isSelected ? '#C7D2FE' : inPath ? '#E0E7FF' : '#FFFFFF'} stroke={isSelected ? '#5A67D8' : gap ? '#B91C1C' : '#E2E8F0'} strokeDasharray={gap ? '2 3' : undefined} />
            <text className="cn" x={node.x + 14} y={y + 15}>{field.name}</text>
            <text className="ct" x={node.x + NODE_W - 12} y={y + 15} textAnchor="end" style={gap ? { fill: '#B91C1C' } : undefined}>{gap ? 'source missing' : shortType(field.dataType)}</text>
          </g>;
        })}
      </g>;
    })}
  </svg>;

  let detail: React.ReactNode = <article className="lineage-detail"><p className="muted">Click a table to open its columns and highlight everything upstream and downstream of it. Click a column to follow it end to end. Click a link to see its evidence.</p></article>;
  if (edge) {
    const isColumn = data.columnEdges.includes(edge);
    detail = <article className="lineage-detail"><div className="lineage-detail-head"><h2>{label(edge.from)} → {label(edge.to)}</h2>{methodChip(edge.method)}</div>
      <p>{edge.explanations.join(' ') || 'Recorded data flow.'}</p>
      <dl className="lineage-kv"><dt>Evidence</dt><dd>{edge.methods.map((method) => EVIDENCE[method].label).join(', ')} · {edge.evidenceCount} evidence item{edge.evidenceCount === 1 ? '' : 's'}</dd>
        <dt>Approval status</dt><dd>{edge.reviewStatus === 'accepted' ? 'Accepted' : edge.reviewStatus === 'disputed' ? 'Disputed' : 'Unreviewed'}</dd>
        <dt>Verification</dt><dd>{edge.verification === 'run_verified' ? 'Verified by a run' : edge.verification === 'reconciled' ? 'Reconciled' : 'Not verified by a run yet'}</dd>
        <dt>Collected by</dt><dd>{edge.collectors.map((item) => item.replace(/-v\d+$/, '').replaceAll('-', ' ')).join(', ')}</dd></dl>
      {!isColumn && <Table caption="Columns on this link" headers={['From column', 'To column', 'How']} rows={data.columnEdges.filter((item) => fieldById.get(item.from)?.datasetId === edge.from && fieldById.get(item.to)?.datasetId === edge.to).map((item) => [<code key="f">{fieldById.get(item.from)!.name}</code>, <code key="t">{fieldById.get(item.to)!.name}</code>, item.transformation === 'derived' ? 'Computed' : 'Copied'])} />}
    </article>;
  } else if (column && columnClosure) {
    const field = fieldById.get(column)!; const dataset = datasetById.get(field.datasetId)!;
    const ordered = [...columnClosure.nodes].sort((a, b) => (layout.lane.get(fieldById.get(a)!.datasetId) ?? 0) - (layout.lane.get(fieldById.get(b)!.datasetId) ?? 0) || label(a).localeCompare(label(b)));
    const sources = ordered.filter((id) => !columnEdges.some((item) => item.to === id && columnClosure.edges.has(item)));
    const gaps = ordered.flatMap((id) => gapsFor(id));
    detail = <article className="lineage-detail"><div className="lineage-detail-head"><div><p className="faint">Column flow · {dataset.sourceName}</p><h2><code>{dataset.name}.{field.name}</code></h2></div>
      <div className="lineage-actions"><Button size="small" onClick={() => props.onAsk(`Where does ${dataset.name}.${field.name} come from?`)}>Ask where it comes from</Button><Button size="small" onClick={() => props.onAsk(`What breaks if ${dataset.name}.${field.name} changes?`)}>Ask what depends on it</Button></div></div>
      <div className="lineage-stats"><div><b>{sources.length}</b><span>source columns</span></div><div><b>{ordered.length - 1}</b><span>columns on its path</span></div><div><b>{gaps.length}</b><span>missing links</span></div></div>
      <Table caption="Every column on its path" headers={['System', 'Column', '', 'How it gets its value']} rows={ordered.map((id) => {
        const inputs = columnEdges.filter((item) => item.to === id && columnClosure.edges.has(item));
        const role = id === column ? <Badge key="r">Selected</Badge> : columnClosure.up.has(id) ? <Badge key="r" tone="muted">Upstream</Badge> : <Badge key="r" tone="muted">Downstream</Badge>;
        return [datasetById.get(fieldById.get(id)!.datasetId)!.sourceName, <Button variant="ghost" size="small" key="c" className="lineage-link" onClick={() => chooseColumn(id)}><code>{label(id)}</code></Button>, role,
          <div key="h">{inputs.map((item) => <div key={item.relationshipId}>{methodChip(item.method)} <span className="muted">{item.transformation === 'derived' ? 'computed' : 'copied'} from <code>{label(item.from)}</code></span></div>)}{gapsFor(id).map((gap) => <div key={gap.gapId}>{methodChip('gap')} <span className="muted">{gap.reason}</span></div>)}{!inputs.length && !gapsFor(id).length && <span className="faint">Starts here</span>}</div>];
      })} />
      <p className="faint">Column lineage comes from parsed view SQL and dbt models. A link is drawn only when the SQL or the dbt project proves it; anything else is shown as missing.</p></article>;
  } else if (selected) {
    const dataset = datasetById.get(selected)!; const reach = closure(selected, tableEdges);
    const methods: Record<Filter, number> = { declared: 0, parsed: 0, observed: 0, inferred: 0, gap: 0 }; for (const item of reach.edges) methods[item.method]++;
    const total = reach.edges.size || 1; const gaps = gapsFor(selected);
    const columns = layout.fieldsOf.get(selected) ?? [];
    detail = <div className="lineage-detail-grid"><article className="lineage-detail"><div><p className="faint">{dataset.sourceName}</p><h2>{dataset.name}</h2></div>
      <div className="lineage-stats"><div><b>{[...reach.up].filter((id) => !tableEdges.some((item) => item.to === id)).length}</b><span>starting points</span></div><div><b>{reach.nodes.size - 1}</b><span>objects on its paths</span></div><div><b>{reach.down.size}</b><span>objects affected by a change here</span></div></div>
      <div><p className="faint">How its links are known ({reach.edges.size} links)</p><div className="lineage-coverage">{(Object.keys(EVIDENCE) as Filter[]).map((key) => methods[key] ? <i key={key} style={{ width: `${(methods[key] / total) * 100}%`, background: EVIDENCE[key].color }} /> : null)}</div>
        <p className="lineage-legend">{(Object.keys(EVIDENCE) as Filter[]).filter((key) => methods[key]).map((key) => <span key={key}>{EVIDENCE[key].label} {methods[key]}</span>)}</p></div>
      <div><h3>Direct inputs</h3><ul className="lineage-inputs">{tableEdges.filter((item) => item.to === selected).map((item) => <li key={item.relationshipId}><b>{label(item.from)}</b> {methodChip(item.method)}<div className="faint">{item.explanations.join(' ')}</div></li>)}
        {gaps.map((gap) => <li key={gap.gapId}>{methodChip('gap')}<div className="faint">{gap.reason}</div></li>)}
        {!tableEdges.some((item) => item.to === selected) && !gaps.length && <li className="faint">Nothing upstream: this is where the data starts.</li>}</ul></div>
      <div className="lineage-actions"><Button size="small" onClick={() => props.onOpenDictionary(dataset.sourceId)}>Open in Dictionary</Button></div></article>
      <article className="lineage-detail"><h2>Columns and where they come from</h2><Table caption={`Columns of ${dataset.name}`} headers={['Column', 'Type', 'Comes from']} rows={columns.map((field) => {
        const inputs = data.columnEdges.filter((item) => item.to === field.assetId);
        return [<Button variant="ghost" size="small" key="c" className="lineage-link" onClick={() => chooseColumn(field.assetId)}><code>{field.name}</code></Button>, field.dataType ?? '', <div key="s">{inputs.map((item) => <div key={item.relationshipId}>{methodChip(item.method)} <code>{label(item.from)}</code></div>)}{gapsFor(field.assetId).map((gap) => <div key={gap.gapId}>{methodChip('gap')} <span className="muted">{gap.reason}</span></div>)}{!inputs.length && !gapsFor(field.assetId).length && <span className="faint">Starts here</span>}</div>];
      })} /></article></div>;
  }

  return <div className="lineage-graph-page">
    <div className="lineage-tiles"><div><b>{data.datasets.length}</b><span>tables and views</span></div><div><b>{systems}</b><span>systems on the path</span></div><div><b>{data.tableEdges.length}</b><span>links, {data.tableEdges.length ? Math.round((evidenced / data.tableEdges.length) * 100) : 0}% evidenced</span></div><div><b>{counts.inferred + counts.gap}</b><span>probable or missing links</span></div><div><b>{unused}</b><span>objects used by nothing</span></div></div>
    <article className="lineage-canvas-card">
      <div className="lineage-toolbar"><div className="lineage-filters" role="group" aria-label="Evidence filters">{(Object.keys(EVIDENCE) as Filter[]).map((key) => <Button size="small" key={key} className={`lineage-filter${off[key] ? ' off' : ''}`} aria-pressed={!off[key]} onClick={() => setOff({ ...off, [key]: !off[key] })}><i style={{ borderTop: `3px ${EVIDENCE[key].dash ? (key === 'gap' ? 'dotted' : 'dashed') : 'solid'} ${EVIDENCE[key].color}` }} />{EVIDENCE[key].label} <span className="faint">{counts[key]}</span></Button>)}</div>
        <form className="lineage-find" onSubmit={(event) => { event.preventDefault(); setFind(query); }}><Input aria-label="Find a table" placeholder="Find a table or view" value={query} onChange={(event) => setQuery(event.target.value)} /><Button size="small" type="submit">Find</Button></form></div>
      <div className="lineage-toolbar"><div className="lineage-filters"><span className="faint">Try:</span>
        {deepest && <Button size="small" onClick={() => chooseColumn(deepest.assetId)}>Trace {label(deepest.assetId)}</Button>}
        {firstGap && <Button size="small" onClick={() => { const field = fieldById.get(firstGap.assetId); if (field) chooseColumn(firstGap.assetId); else chooseTable(firstGap.assetId); }}>Follow the gap at {label(firstGap.assetId)}</Button>}
        {(selected || column || edgeId || find) && <Button size="small" onClick={clear}>Clear</Button>}</div>
        <div className="lineage-filters"><Button size="small" onClick={() => setOpen(Object.fromEntries(data.datasets.map((dataset) => [dataset.assetId, true])))}>Show all columns</Button><Button size="small" onClick={() => setOpen({})}>Hide all columns</Button></div></div>
      <div className="lwrap">{graph}</div>
      <p className="faint">Click a table to open its columns; click a column to follow it end to end. Blue boxes are views, yellow boxes are dbt models. A red dotted arrow is a missing link: its source is not visible to any connected source.</p>
    </article>
    {detail}
  </div>;
}

type LineageAnswerData = { asset: string; direction: 'upstream' | 'downstream'; sourceName: string; steps: Array<{ from: string; to: string; method: Method; how: string; hop: number }>; gaps: Array<{ asset: string; reason: string }>; methods: Record<Filter, number> };

/** A lineage answer in chat: the flow end to end, how each link is known, the numbered steps and any missing links. */
export function LineageAnswer(props: { lineage: LineageAnswerData; onOpen: () => void }) {
  const { lineage } = props;
  const hops = Math.max(0, ...lineage.steps.map((step) => step.hop));
  const columns: string[][] = [[lineage.asset]];
  for (let hop = 1; hop <= hops; hop++) columns.push([...new Set(lineage.steps.filter((step) => step.hop === hop).map((step) => lineage.direction === 'upstream' ? step.from : step.to))].sort());
  if (lineage.direction === 'upstream') columns.reverse();
  const width = Math.max(1, columns.length) * 250; const height = Math.max(...columns.map((column) => column.length), 1) * 46 + 40;
  const position = new Map<string, { x: number; y: number }>();
  columns.forEach((column, index) => column.forEach((name, row) => { if (!position.has(name)) position.set(name, { x: 12 + index * 250, y: 20 + row * 46 }); }));
  return <div className="lineage-answer">
    {lineage.steps.length > 0 && <div className="lwrap"><svg className="flow" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Lineage of ${lineage.asset}: ${lineage.steps.length} links`}>
      <defs>{(Object.keys(EVIDENCE) as Filter[]).map((key) => <marker key={key} id={`answer-arrow-${key}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill={EVIDENCE[key].color} /></marker>)}</defs>
      {lineage.steps.map((step, index) => { const a = position.get(step.from); const b = position.get(step.to); if (!a || !b) return null; const style = EVIDENCE[step.method];
        return <path key={index} d={curve(a.x + 220, a.y + 14, b.x - 2, b.y + 14)} fill="none" stroke={style.color} strokeDasharray={style.dash} strokeWidth={1.8} markerEnd={`url(#answer-arrow-${step.method})`}><title>{step.how}</title></path>; })}
      {[...position.entries()].map(([name, point]) => <g key={name}><rect x={point.x} y={point.y} width={220} height={28} rx={6} fill={name === lineage.asset ? '#E0E7FF' : '#FFFFFF'} stroke={name === lineage.asset ? '#5A67D8' : '#CBD5E1'} /><text className="fc" x={point.x + 8} y={point.y + 18} style={{ fontSize: 11 }}>{name.length > 32 ? `${name.slice(0, 31)}…` : name}</text></g>)}
    </svg></div>}
    <p className="lineage-legend">{(Object.keys(EVIDENCE) as Filter[]).filter((key) => lineage.methods[key]).map((key) => <span key={key}><span className="lineage-method" style={{ color: EVIDENCE[key].color, background: `${EVIDENCE[key].color}1a` }}>{EVIDENCE[key].label}</span> {lineage.methods[key]}</span>)}</p>
    {lineage.steps.length > 0 && <details className="lineage-steps-wrap"><summary>Every step, in order ({lineage.steps.length} {lineage.steps.length === 1 ? 'link' : 'links'})</summary><ol className="lineage-steps">{lineage.steps.map((step, index) => <li key={index}><code>{step.to}</code> <span className="muted">← {step.how}</span></li>)}</ol></details>}
    {lineage.gaps.map((gap, index) => <p key={index} className="graph-gap"><span className="lineage-method" style={{ color: EVIDENCE.gap.color, background: `${EVIDENCE.gap.color}1a` }}>Missing</span> <code>{gap.asset}</code>: {gap.reason}</p>)}
    <div className="lineage-actions"><Button size="small" onClick={props.onOpen}>Open in Lineage</Button></div>
  </div>;
}

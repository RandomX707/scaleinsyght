import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, FileInput, Input, Modal, Select, Textarea } from '@scaleinsyght/ui';
import './dictionary.css';

/**
 * The Dictionary (docs/phases/dictionary-rebuild.md). Lazy: the object list is paged and searched on the server and an
 * object's details load when it is opened. Definitions are shown scrubbed; "Show original" fetches the live text and
 * keeps it only in this page's memory (decision 53).
 */
type Source = { connectionId: string; type: string; name: string; objects: number; importedDictionary: boolean };
type Summary = {
  source: { connectionId: string; name: string; type: string };
  importedDictionary: { fileName: string; importedAt: string; importedBy: string | null; tables: number; columns: number } | null;
  hasVendorDictionary: boolean;
  counts: { standard: number; custom: number; tables: number; customTables: number; views: number; procedures: number; functions: number; packages: number; worksheets: number; calculatedFields: number; dbtTests: number | null };
  coverage: { tables: { documented: number; total: number }; columns: { documented: number; total: number } };
  newerThanDictionary: { count: number; names: string[] } | null;
};
type ListItem = { name: string; kind: string; columns: number | null; matchedColumns?: number };
type Group = { key: string; label: string; total: number; items: ListItem[]; nextOffset: number | null };
type ObjectList = { tab: 'standard' | 'custom'; hasVendorDictionary: boolean; counts: { standard: number; custom: number }; groups: Group[]; sqlHits: Array<{ name: string; kind: string; matches: number; lines: Array<{ line: number; text: string }> }> };
type Column = { name: string; label: string | null; dataType: string | null; nullable: boolean | null; tags: string[]; key: boolean; statsWithheld: boolean; withheldReason?: string; nullRate: number | null; distinctCount: number | null; description: string | null; usedBy: number };
type Detail = {
  source: { connectionId: string; name: string; type: string };
  name: string; kind: string; custom: boolean; procedureKind: string | null;
  description: { text: string; origin: 'imported' | 'dbt' | 'drafted' | 'approved' | 'edited'; by?: string | null; at?: string | null } | null;
  stats: { rows: number | null; lastProfiled: string | null; dependentReports: number; builtBy: string[] } | null;
  columns: Column[]; keys: Array<{ column: string; references: string; evidence: string }>;
  joins: Array<{ column: string; otherTable: string; otherColumn: string; direction: string; evidenceMethod: string; reviewStatus: string; verification: string | null; confidence: number | null; probable: boolean }>;
  tests: Array<{ column: string | null; test: string }>;
  usedBy: Array<{ name: string; kind: string; how: string; source: string }>;
  definition: null | { kind: string; encrypted: boolean; text: string | null; literalsHidden: boolean; version: number; capturedAt: string; parameters: Array<{ name: string; dataType: string; mode: string; declared: boolean }>;
    writes: Array<{ table: string; mode: string }>; reads: string[]; calls: string[]; steps: string[]; calledBy: string[]; runBy: string[];
    tablesAndColumns: Array<{ table: string; access: string; columns: Array<{ name: string; used: boolean; dropped: boolean }> }>; originalAvailable: boolean };
};

const KIND_LABEL: Record<string, string> = { table: 'Table', view: 'View', materialized_view: 'Materialized view', procedure: 'Stored procedure', function: 'Function', package: 'SSIS package', sheet: 'Sheet', model: 'dbt model', source: 'dbt source', datasource: 'Data source', worksheet: 'Worksheet', calculated_field: 'Calculated field' };
const PROCEDURE_KIND: Record<string, string> = { fact_loader: 'Fact loaders', report: 'Report procedures', data_check: 'Data checks', archive: 'Archive', utility: 'Utilities' };
const HOW: Record<string, string> = { 'truncate-insert': 'TRUNCATE + INSERT', merge: 'MERGE', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE' };
const DEFAULT_SCHEMAS = new Set(['dbo', 'public', 'PUBLIC']);
const TYPE_LABEL: Record<string, string> = { postgres: 'PostgreSQL', sql_server: 'SQL Server', snowflake: 'Snowflake', excel: 'Excel', dbt: 'dbt', tableau: 'Tableau', power_bi: 'Power BI' };
const number = (value: number) => value.toLocaleString('en-US');

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error((body.error ?? 'The request could not be completed').replaceAll('_', ' ')); }
  return response.json() as Promise<T>;
}
/** The object's own name, without a default schema; other schemas stay visible. */
export function shortName(name: string): string {
  const parts = name.split('.');
  return parts.length === 2 && DEFAULT_SCHEMAS.has(parts[0]!) ? parts[1]! : name;
}

/** SQL with keywords, strings, placeholders and comments marked, for the SQL card. Text only; never HTML. */
export function highlightSql(text: string): ReactNode[] {
  const pattern = /(--[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*)|('(?:''|[^'])*'|"<string>")|(<number>|\b\d+(?:\.\d+)?\b)|\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|MERGE|USING|WHEN|MATCHED|THEN|ELSE|END|CASE|TRUNCATE|TABLE|CREATE|ALTER|PROCEDURE|FUNCTION|VIEW|AS|BEGIN|DECLARE|EXEC|EXECUTE|RETURN|RETURNS|GROUP|BY|ORDER|HAVING|EXISTS|IN|IS|NULL|DISTINCT|COUNT|SUM|IF|WITH|UNION|ALL|LANGUAGE|IF)\b/gi;
  const out: ReactNode[] = []; let last = 0; let key = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) out.push(text.slice(last, match.index));
    const className = match[1] ? 'sql-comment' : match[2] ? 'sql-string' : match[3] ? 'sql-number' : 'sql-keyword';
    out.push(<span key={key++} className={className}>{match[0]}</span>);
    last = match.index! + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Section(props: { id: string; title: string; aside?: ReactNode; open: boolean; onToggle: (id: string, open: boolean) => void; children: ReactNode }) {
  return <details className="dict-card" open={props.open} onToggle={(event) => { const open = (event.currentTarget as HTMLDetailsElement).open; if (open !== props.open) props.onToggle(props.id, open); }}>
    <summary><span className="dict-card-title">{props.title}</span>{props.aside && <span className="dict-card-aside" onClick={(event) => event.preventDefault()}>{props.aside}</span>}</summary>
    <div className="dict-card-body">{props.children}</div>
  </details>;
}

function Kv(props: { rows: Array<[string, ReactNode]> }) {
  return <dl className="dict-kv">{props.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function DictionaryPage(props: { connectionId: string; navigate: (path: string) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tab, setTab] = useState<'standard' | 'custom'>('standard');
  const [query, setQuery] = useState(''); const [debounced, setDebounced] = useState('');
  const [list, setList] = useState<ObjectList | null>(null);
  const [open, setOpen] = useState<string[]>([]); const [active, setActive] = useState<string>('');
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [cards, setCards] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState(false);
  const listRequest = useRef(0);
  const base = `/api/connections/${encodeURIComponent(props.connectionId)}`;

  useEffect(() => { void get<{ sources: Source[] }>('/api/dictionary/sources').then((body) => setSources(body.sources)).catch(() => undefined); }, []);
  useEffect(() => {
    setSummary(null); setList(null); setOpen([]); setActive(''); setDetails({}); setQuery(''); setDebounced(''); setError('');
    void get<Summary>(`${base}/dictionary/summary`).then(setSummary).catch((reason) => setError(reason instanceof Error ? reason.message : 'The dictionary could not be loaded.'));
    // ?object= opens that object directly, for links from the ER explorer and elsewhere.
    const requested = new URLSearchParams(location.search).get('object'); if (requested) void openObject(requested);
  }, [props.connectionId]);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    const request = ++listRequest.current;
    void get<ObjectList>(`${base}/dictionary/objects?tab=${tab}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`)
      .then((body) => { if (request === listRequest.current) setList(body); })
      .catch((reason) => { if (request === listRequest.current) setError(reason instanceof Error ? reason.message : 'Objects could not be loaded.'); });
  }, [props.connectionId, tab, debounced]);

  async function showMore(group: Group) {
    if (group.nextOffset === null) return;
    const body = await get<ObjectList>(`${base}/dictionary/objects?tab=${tab}&group=${group.key}&offset=${group.nextOffset}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`);
    const more = body.groups[0]; if (!more) return;
    setList((current) => current && { ...current, groups: current.groups.map((item) => item.key === group.key ? { ...item, items: [...item.items, ...more.items], nextOffset: more.nextOffset } : item) });
  }
  async function openObject(name: string) {
    setOpen((current) => current.includes(name) ? current : [...current, name]); setActive(name);
    if (details[name]) return;
    try { const detail = await get<Detail>(`${base}/dictionary/object?name=${encodeURIComponent(name)}`); setDetails((current) => ({ ...current, [name]: detail })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The object could not be loaded.'); }
  }
  function closeObject(name: string) {
    setOpen((current) => { const next = current.filter((item) => item !== name); if (active === name) setActive(next.at(-1) ?? ''); return next; });
  }
  async function importDictionary(file?: File) {
    if (!file) return;
    const format = file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const response = await fetch(`${base}/dictionary/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format, filename: file.name, contentBase64: btoa(binary) }) });
    const body = await response.json().catch(() => ({})) as { imported?: number; error?: string };
    if (!response.ok) { setError(`The dictionary could not be imported: ${(body.error ?? 'unknown error').replaceAll('_', ' ')}.`); return; }
    setMessage(`${number(body.imported ?? 0)} descriptions imported from ${file.name}.`);
    setSummary(await get<Summary>(`${base}/dictionary/summary`)); setDetails({});
    setList(await get<ObjectList>(`${base}/dictionary/objects?tab=${tab}`));
  }
  async function reloadDetail(name: string) {
    const detail = await get<Detail>(`${base}/dictionary/object?name=${encodeURIComponent(name)}`); setDetails((current) => ({ ...current, [name]: detail }));
    void get<Summary>(`${base}/dictionary/summary`).then(setSummary).catch(() => undefined);
  }
  const cardIds = useMemo(() => {
    const detail = active ? details[active] : null;
    if (!detail) return ['dict-summary', 'dict-agents'];
    return detail.definition ? ['def-what', 'def-logic', 'def-params', 'def-tables', 'def-calls', 'def-sql', 'cols', 'used', 'keys', 'joins', 'tests'] : ['cols', 'used', 'keys', 'joins', 'tests'];
  }, [active, details]);
  const isOpen = (id: string) => cards[id] ?? id !== 'dict-agents';
  const toggle = (id: string, value: boolean) => setCards((current) => ({ ...current, [id]: value }));
  const setAll = (value: boolean) => setCards((current) => ({ ...current, ...Object.fromEntries(cardIds.map((id) => [id, value])) }));

  const source = summary?.source;
  const groupingNote = list && !list.hasVendorDictionary && summary && !['excel', 'dbt', 'tableau'].includes(summary.source.type)
    ? 'No vendor dictionary imported, so objects are grouped by type. Custom objects are found by your X_ naming convention.' : null;

  return <section className="dictionary-page">
    <div className="page-heading dict-heading">
      <div><h1>Dictionary</h1><p>Every table, procedure, view and package in a source, described in plain language, with what the last profile found.</p></div>
      <label className="dict-source">Source<Select aria-label="Source" value={props.connectionId} onChange={(event) => props.navigate(`/dictionary?connection=${event.target.value}`)}>
        {sources.map((item) => <option key={item.connectionId} value={item.connectionId}>{item.name} · {TYPE_LABEL[item.type] ?? item.type}</option>)}
        {!sources.some((item) => item.connectionId === props.connectionId) && <option value={props.connectionId}>{source?.name ?? 'Loading…'}</option>}
      </Select></label>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p role="status" className="dict-message">{message}</p>}
    <div className="dict-layout">
      <nav className="dict-side" aria-label="Objects">
        {summary && <div className="dict-source-card">
          {summary.importedDictionary ? <><strong>Vendor dictionary imported</strong><p>{summary.importedDictionary.fileName} · {number(summary.importedDictionary.tables)} tables · {new Date(summary.importedDictionary.importedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p></>
            : <><strong>{summary.source.name}</strong><p>{TYPE_LABEL[summary.source.type] ?? summary.source.type} · {number(summary.counts.standard + summary.counts.custom)} objects</p></>}
          <Button size="small" onClick={() => setActive('')}>Details</Button>
        </div>}
        <div className="dict-segment" role="tablist" aria-label="Standard or custom">
          {(['standard', 'custom'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{item === 'standard' ? 'Standard' : 'Custom'} <span>{number(list?.counts[item] ?? (item === 'standard' ? summary?.counts.standard ?? 0 : summary?.counts.custom ?? 0))}</span></button>)}
        </div>
        <Input type="search" aria-label="Search tables, columns or SQL code" placeholder="Search tables, columns or SQL code" value={query} onChange={(event) => setQuery(event.target.value)} />
        {groupingNote && <p className="dict-note">{groupingNote}</p>}
        {!list && <p role="status" className="dict-note">Loading objects…</p>}
        {list && !list.groups.length && !list.sqlHits.length && <p className="dict-note">{debounced ? `Nothing matches “${debounced}” here.` : tab === 'custom' ? 'No custom objects in this source.' : 'No standard objects in this source.'}</p>}
        {list?.groups.map((group) => <div className="dict-group" key={group.key}>
          <h3><span>{group.label}</span><span>{group.items.length < group.total ? `${number(group.items.length)} of ${number(group.total)}` : number(group.total)}</span></h3>
          <ul>{group.items.map((item) => <li key={item.name}><button type="button" className={active === item.name ? 'is-active' : ''} aria-current={active === item.name ? 'true' : undefined} title={item.name} onClick={() => void openObject(item.name)}>
            <span className="mono">{shortName(item.name)}</span>{item.matchedColumns ? <span className="dict-count">{item.matchedColumns} col</span> : null}</button></li>)}</ul>
          {group.nextOffset !== null && <Button size="small" onClick={() => void showMore(group)}>Show more</Button>}
        </div>)}
        {list && list.sqlHits.length > 0 && <div className="dict-group">
          <h3><span>In SQL code · {list.sqlHits.length}</span><span>{number(list.sqlHits.reduce((total, hit) => total + hit.matches, 0))} matches</span></h3>
          <ul>{list.sqlHits.map((hit) => <li key={hit.name}><button type="button" className={`dict-sql-hit${active === hit.name ? ' is-active' : ''}`} onClick={() => void openObject(hit.name)}>
            <span className="dict-hit-head"><span className="mono">{shortName(hit.name)}</span><span className="dict-count">{hit.matches}</span></span>
            {hit.lines.slice(0, 1).map((line) => <span key={line.line} className="dict-snippet mono">line {line.line}: {line.text}</span>)}</button></li>)}</ul>
        </div>}
      </nav>
      <div className="dict-main">
        <div className="dict-tabs-row">
          <div className="dict-pills" role="tablist" aria-label="Open objects">
            <button type="button" role="tab" aria-selected={!active} className="dict-pill" onClick={() => setActive('')}>{summary?.importedDictionary ? 'Imported dictionary' : 'Overview'}</button>
            {open.map((name) => <span key={name} className={`dict-pill${active === name ? ' is-active' : ''}`}><button type="button" role="tab" aria-selected={active === name} onClick={() => setActive(name)} className="mono">{shortName(name)}</button><button type="button" aria-label={`Close ${name}`} onClick={() => closeObject(name)}>×</button></span>)}
          </div>
          <div className="dict-tabs-actions"><Button size="small" onClick={() => setAll(false)}>Collapse all</Button><Button size="small" onClick={() => setAll(true)}>Expand all</Button></div>
        </div>
        {!active && summary && <Landing summary={summary} isOpen={isOpen} toggle={toggle} onExport={() => setExporting(true)} onImport={(file) => void importDictionary(file)} />}
        {active && !details[active] && <p role="status">Loading {shortName(active)}…</p>}
        {active && details[active] && <ObjectView key={active} detail={details[active]!} base={base} isOpen={isOpen} toggle={toggle} navigate={props.navigate} onOpen={(name) => void openObject(name)} onChanged={() => void reloadDetail(active)} setMessage={setMessage} />}
      </div>
    </div>
    <ExportNotice open={exporting} sources={sources} current={props.connectionId} onClose={() => setExporting(false)} onDone={(text) => { setExporting(false); setMessage(text); }} />
  </section>;
}

function Landing(props: { summary: Summary; isOpen: (id: string) => boolean; toggle: (id: string, open: boolean) => void; onExport: () => void; onImport: (file?: File) => void }) {
  const { summary } = props; const imported = summary.importedDictionary;
  const percent = (part: number, total: number) => total ? `${Math.round(part / total * 100)}%` : '0%';
  const type = summary.source.type;
  const stats: Array<[string, string]> = type === 'tableau' ? [[number(summary.counts.tables), 'data sources'], [number(summary.counts.worksheets), 'worksheets'], [number(summary.counts.calculatedFields), 'calculated fields'], [percent(summary.coverage.columns.documented, summary.coverage.columns.total), 'of fields documented']]
    : type === 'dbt' ? [[number(summary.counts.tables), 'models and sources'], [number(summary.counts.dbtTests ?? 0), 'dbt tests'], [`${number(summary.coverage.tables.documented)} of ${number(summary.coverage.tables.total)}`, 'models documented'], [`${number(summary.coverage.columns.documented)} of ${number(summary.coverage.columns.total)}`, 'columns documented']]
      : imported ? [[number(imported.tables), 'tables in the dictionary'], [number(summary.counts.tables - summary.counts.customTables), 'standard tables in this source'], [number(summary.newerThanDictionary?.count ?? 0), 'newer than this dictionary'], [number(summary.counts.customTables), 'custom tables, not in the dictionary']]
        : [[number(summary.counts.tables), type === 'excel' ? 'sheets' : 'tables'], [number(summary.counts.views), 'views'], [number(summary.counts.procedures + summary.counts.functions), 'procedures and functions'], [number(summary.counts.customTables), 'custom tables']];
  return <>
    <Section id="dict-summary" title={imported ? 'Your imported dictionary' : 'This source'} open={props.isOpen('dict-summary')} onToggle={props.toggle}>
      <p className="dict-eyebrow">{summary.source.name}</p>
      <div className="dict-stats">{stats.map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
      <Kv rows={[
        ...(imported ? [['Imported file', <span className="mono" key="f">{imported.fileName}</span>], ['Imported', `${new Date(imported.importedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}${imported.importedBy ? ` by ${imported.importedBy}` : ''}`]] as Array<[string, ReactNode]> : []),
        ['Documented tables', `${number(summary.coverage.tables.documented)} of ${number(summary.coverage.tables.total)} (${percent(summary.coverage.tables.documented, summary.coverage.tables.total)})`],
        ['Documented columns', `${number(summary.coverage.columns.documented)} of ${number(summary.coverage.columns.total)} (${percent(summary.coverage.columns.documented, summary.coverage.columns.total)})`],
        ['Added by Scale Insyght', 'Plain-language descriptions, custom objects, row counts, nulls and distinct values, sensitivity tags, procedure logic parsed from SQL, links to lineage'],
      ]} />
      {imported && summary.newerThanDictionary && summary.newerThanDictionary.count > 0 && <p>{number(summary.newerThanDictionary.count)} {summary.newerThanDictionary.count === 1 ? 'table was' : 'tables were'} first seen after this dictionary was imported, so {summary.newerThanDictionary.count === 1 ? 'it has' : 'they have'} no entry in it yet: <span className="mono">{summary.newerThanDictionary.names.slice(0, 5).map(shortName).join(', ')}{summary.newerThanDictionary.count > 5 ? '…' : ''}</span></p>}
      {!imported && !['excel', 'dbt', 'tableau'].includes(type) && <p className="dict-note">No vendor dictionary imported. Descriptions are drafted by Scale Insyght from names, keys and parsed SQL, and count as documented once someone approves them.</p>}
      <div className="dict-actions">
        {!['excel', 'dbt', 'tableau'].includes(type) && <FileInput label={imported ? 'Upload a newer dictionary' : 'Upload a dictionary (CSV or Excel)'} accept=".csv,.xlsx" onChange={(event) => props.onImport(event.target.files?.[0])} />}
        <Button variant="primary" size="small" onClick={props.onExport}>Export as interactive HTML</Button>
      </div>
    </Section>
    <Section id="dict-agents" title="How the agents use it" open={props.isOpen('dict-agents')} onToggle={props.toggle}>
      <p><strong>Writing SQL.</strong> Descriptions and keys tell the agents which table and join to use.</p>
      <p><strong>Lineage.</strong> Procedure and view SQL is parsed for what each object reads and writes; that is parsed evidence, never shown as verified.</p>
      <p><strong>ER diagrams.</strong> Declared keys become solid links; links found only in the data stay probable until approved.</p>
      <p><strong>Sensitive data.</strong> Tagged columns are never sampled or sent to the AI model, and their statistics are withheld. Definitions reach the model only with literal values replaced.</p>
    </Section>
  </>;
}

function ObjectView(props: { detail: Detail; base: string; isOpen: (id: string) => boolean; toggle: (id: string, open: boolean) => void; navigate: (path: string) => void; onOpen: (name: string) => void; onChanged: () => void; setMessage: (text: string) => void }) {
  const { detail } = props; const definition = detail.definition;
  const [hidden, setHidden] = useState(false); const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(detail.description?.text ?? '');
  const [showAll, setShowAll] = useState(false); const [defTab, setDefTab] = useState('overview');
  const [original, setOriginal] = useState<string | null>(null); const [originalError, setOriginalError] = useState('');
  const keyColumns = detail.columns.filter((column) => column.key);
  const shownColumns = showAll || !keyColumns.length ? detail.columns : keyColumns;
  async function review(action: 'approve' | 'edit') {
    const response = await fetch(`${props.base}/dictionary/description`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: detail.name, action, ...(action === 'edit' ? { text: draft } : {}) }) });
    if (!response.ok) { props.setMessage('The description could not be saved.'); return; }
    setEditing(false); props.setMessage(action === 'approve' ? 'Description approved.' : 'Description saved.'); props.onChanged();
  }
  async function exportObject(format: 'markdown' | 'docx' | 'copy') {
    const response = await fetch(`${props.base}/dictionary/export?format=${format === 'copy' ? 'markdown' : format}&object=${encodeURIComponent(detail.name)}`);
    if (!response.ok) { props.setMessage('Export is available for tables, views and sheets.'); return; }
    if (format === 'copy') { await navigator.clipboard.writeText(await response.text()); props.setMessage('Copied as Markdown.'); return; }
    const link = document.createElement('a'); link.href = URL.createObjectURL(await response.blob());
    link.download = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'dictionary'; link.click(); URL.revokeObjectURL(link.href);
  }
  async function showOriginal() {
    setOriginalError('');
    const response = await fetch(`${props.base}/dictionary/original?name=${encodeURIComponent(detail.name)}`);
    if (!response.ok) { setOriginalError(response.status === 409 ? 'The source encrypts this definition.' : 'The source could not be reached, so the original is not available now.'); return; }
    setOriginal((await response.json() as { text: string }).text);
  }
  const origin = detail.description?.origin;
  const reviewChip = origin === 'drafted' ? <Badge tone="warn">Drafted by Scale Insyght · waiting for approval</Badge> : origin === 'approved' ? <Badge tone="good">Approved{detail.description?.by ? ` by ${detail.description.by}` : ''}</Badge>
    : origin === 'edited' ? <Badge tone="good">Edited{detail.description?.by ? ` by ${detail.description.by}` : ''}</Badge> : origin === 'dbt' ? <Badge tone="muted">From the dbt project</Badge> : origin === 'imported' ? <Badge tone="muted">From the imported dictionary</Badge> : null;
  const isTableLike = !definition || ['view', 'materialized_view'].includes(definition.kind);
  const stats: Array<[string, string]> = definition && !['view', 'materialized_view', 'calculated_field'].includes(definition.kind)
    ? [[definition.encrypted ? 'Unknown' : number(definition.reads.length), definition.reads.length === 1 ? 'table it reads' : 'tables it reads'], [definition.encrypted ? 'Unknown' : number(definition.writes.length), definition.writes.length === 1 ? 'table it writes' : 'tables it writes'], [number(definition.calledBy.length), 'called by'], [detail.custom ? 'Your team' : 'Vendor', 'built by']]
    : detail.stats ? [[detail.stats.rows === null ? '—' : number(detail.stats.rows), 'rows'], [detail.stats.lastProfiled ? new Date(detail.stats.lastProfiled).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—', 'last profiled'],
      [number(detail.stats.dependentReports), detail.stats.dependentReports === 1 ? 'report depends on it' : 'reports depend on it'], [detail.stats.builtBy.length ? detail.stats.builtBy.map(shortName).join(', ') : detail.custom ? 'Your team' : detail.source.type === 'dbt' ? 'dbt' : 'Source', 'built by']] : [];
  const defTabs = definition && definition.kind !== 'calculated_field' ? [
    { id: 'overview', label: 'Overview' }, { id: 'parameters', label: `Parameters ${definition.parameters.length}` }, { id: 'tables', label: `Tables and columns ${definition.tablesAndColumns.length}` }, { id: 'calls', label: 'Calls' }, { id: 'sql', label: 'SQL' },
  ] : [];
  return <>
    <article className="dict-header">
      <div className="dict-header-top">
        <div><p className="dict-eyebrow">{detail.source.name}</p><h2 className="mono">{shortName(detail.name)}</h2></div>
        <div className="dict-chips"><Badge tone={detail.custom ? 'warn' : 'primary'}>{detail.custom ? KIND_LABEL[detail.kind] : `${detail.source.type === 'dbt' || detail.source.type === 'tableau' || detail.source.type === 'excel' ? '' : 'Standard '}${(KIND_LABEL[detail.kind] ?? detail.kind).toLowerCase()}`}</Badge>
          {detail.procedureKind && detail.custom && <Badge tone="muted">{PROCEDURE_KIND[detail.procedureKind]}</Badge>}
          <Button size="small" aria-expanded={!hidden} onClick={() => setHidden(!hidden)}>{hidden ? 'Show details' : 'Hide details'}</Button></div>
      </div>
      {!hidden && <>
        {editing ? <div className="dict-edit"><Textarea aria-label="Description" value={draft} maxLength={2000} onChange={(event) => setDraft(event.target.value)} /><div className="dict-actions"><Button variant="primary" size="small" disabled={!draft.trim()} onClick={() => void review('edit')}>Save</Button><Button size="small" onClick={() => setEditing(false)}>Cancel</Button></div></div>
          : <p className="dict-description">{detail.description?.text ?? 'No description yet.'}</p>}
        {!editing && (reviewChip || origin === 'drafted') && <div className="dict-review">{reviewChip}{origin === 'drafted' && <><Button variant="primary" size="small" onClick={() => void review('approve')}>Approve</Button><Button size="small" onClick={() => { setDraft(detail.description?.text ?? ''); setEditing(true); }}>Edit</Button></>}
          {(origin === 'approved' || origin === 'edited') && <Button size="small" onClick={() => { setDraft(detail.description?.text ?? ''); setEditing(true); }}>Edit</Button>}</div>}
        {origin === 'drafted' && <p className="dict-note">Drafted from names, keys and parsed SQL only; no data values were used.</p>}
        <Kv rows={[['Type', KIND_LABEL[detail.kind] ?? detail.kind], ['Full name', <span className="mono" key="n">{detail.name}</span>],
          ...(definition?.parameters.length ? [['Parameters', <span className="mono" key="p">{definition.parameters.map((parameter) => parameter.name).join(', ')}</span>]] as Array<[string, ReactNode]> : []),
          ...(definition ? [['Definition captured', `${new Date(definition.capturedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · version ${definition.version}`]] as Array<[string, ReactNode]> : [])]} />
        {stats.length > 0 && <div className="dict-stats">{stats.map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>}
        <div className="dict-header-actions">
          <div className="dict-actions">
            <Button size="small" onClick={() => props.navigate('/lineage')}>Open in Lineage</Button>
            {isTableLike && detail.stats && !['dbt', 'tableau'].includes(detail.source.type) && <Button size="small" onClick={() => props.navigate(`/er?connection=${detail.source.connectionId}&focus=${encodeURIComponent(detail.name)}`)}>Show in ER diagram</Button>}
            <Button size="small" onClick={() => props.navigate(`/?ask=${encodeURIComponent(`What is ${shortName(detail.name)} and how is it used?`)}`)}>Ask about this</Button>
          </div>
          {isTableLike && detail.columns.length > 0 && <div className="dict-actions dict-export"><span>Export</span><Button size="small" onClick={() => void exportObject('markdown')}>Markdown</Button><Button size="small" onClick={() => void exportObject('docx')}>Word</Button><Button size="small" onClick={() => void exportObject('copy')}>Copy</Button></div>}
        </div>
      </>}
    </article>

    {definition?.kind === 'calculated_field' && <Section id="def-sql" title="Formula" open={props.isOpen('def-sql')} onToggle={props.toggle}>
      <p className="dict-note">Literal values hidden. The uploaded workbook is not kept, so the original formula is not available here.</p>
      <pre className="dict-code">{highlightSql(definition.text ?? '')}</pre>
    </Section>}

    {defTabs.length > 0 && <div className="dict-def-tabs" role="tablist" aria-label="Definition">{defTabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={defTab === item.id} onClick={() => setDefTab(item.id)}>{item.label}</button>)}</div>}
    {definition && defTabs.length > 0 && defTab === 'overview' && <>
      <Section id="def-what" title="What it does" open={props.isOpen('def-what')} onToggle={props.toggle}>
        {definition.encrypted ? <p>The source encrypts this definition, so what it reads and writes is unknown.</p> : <Kv rows={[
          ['Writes', definition.writes.length ? <span className="dict-names">{definition.writes.map((write) => <button type="button" key={write.table} className="dict-name mono" onClick={() => props.onOpen(write.table)}>{shortName(write.table)}</button>)}</span> : 'Nothing; it returns a result'],
          ...(definition.writes.length ? [['How', <span key="h">{[...new Set(definition.writes.map((write) => HOW[write.mode] ?? write.mode))].join(', ')} <Badge tone="muted">Parsed from SQL</Badge></span>]] as Array<[string, ReactNode]> : []),
          ['Reads', definition.reads.length ? <span className="dict-names">{definition.reads.map((read) => <button type="button" key={read} className="dict-name mono" onClick={() => props.onOpen(read)}>{shortName(read)}</button>)}</span> : 'No tables'],
        ]} />}
        {definition.steps.length > 0 && <><h4>Logic, parsed from the SQL</h4><ol className="dict-steps">{definition.steps.map((step, index) => <li key={index}>{step.split(/(\b[\w]+\.[\w$#]+\b)/).map((part, partIndex) => partIndex % 2 ? <span key={partIndex} className="mono">{shortName(part)}</span> : part)}</li>)}</ol></>}
      </Section>
    </>}
    {definition && defTab === 'parameters' && <Section id="def-params" title="Parameters" open={props.isOpen('def-params')} onToggle={props.toggle}>
      {definition.parameters.length ? <table className="dict-table"><thead><tr><th scope="col">#</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Direction</th><th scope="col">Source</th></tr></thead>
        <tbody>{definition.parameters.map((parameter, index) => <tr key={parameter.name}><td>{index + 1}</td><td className="mono">{parameter.name}</td><td className="mono">{parameter.dataType}</td><td>{parameter.mode === 'in' ? 'Input' : parameter.mode === 'out' ? 'Output' : 'Input and output'}</td><td><Badge tone="good">Declared</Badge></td></tr>)}</tbody></table>
        : <p>No parameters.</p>}
    </Section>}
    {definition && defTab === 'tables' && <Section id="def-tables" title="Tables and columns" open={props.isOpen('def-tables')} onToggle={props.toggle}>
      {definition.tablesAndColumns.length ? definition.tablesAndColumns.map((item) => <div key={item.table} className="dict-touch">
        <h4><button type="button" className="dict-name mono" onClick={() => props.onOpen(item.table)}>{shortName(item.table)}</button> <span className="dict-note">{item.access}</span></h4>
        <p className="dict-columns">{item.columns.map((column) => <span key={column.name} className={`mono dict-col${column.used ? ' is-used' : ''}${column.dropped ? ' is-dropped' : ''}`} title={column.dropped ? 'Used in the SQL but dropped from the table' : column.used ? 'Named in the SQL' : undefined}>{column.dropped ? <s>{column.name}</s> : column.name}{column.dropped ? ' (dropped)' : ''}</span>)}</p>
      </div>) : <p>No tables found in the SQL.</p>}
      <p className="dict-note">Highlighted columns are named in the SQL. Struck-through columns are named in the SQL but no longer exist in the table.</p>
    </Section>}
    {definition && defTab === 'calls' && <Section id="def-calls" title="Calls" open={props.isOpen('def-calls')} onToggle={props.toggle}>
      <Kv rows={[
        ['Calls', definition.calls.length ? <span className="dict-names">{definition.calls.map((call) => <button type="button" key={call} className="dict-name mono" onClick={() => props.onOpen(call)}>{shortName(call)}</button>)}</span> : 'Nothing'],
        ['Called by', definition.calledBy.length ? <span className="dict-names">{definition.calledBy.map((call) => <button type="button" key={call} className="dict-name mono" onClick={() => props.onOpen(call)}>{shortName(call)}</button>)}</span> : 'Nothing in this source'],
        ['Run by', definition.runBy.length ? definition.runBy.join(', ') : 'Not known: SQL Agent, SSIS and SSRS schedules are not read yet'],
      ]} />
    </Section>}
    {definition && defTab === 'sql' && <Section id="def-sql" title="SQL" open={props.isOpen('def-sql')} onToggle={props.toggle}
      aside={!definition.encrypted && definition.text ? <Button size="small" onClick={() => { void navigator.clipboard.writeText(original ?? definition.text ?? ''); props.setMessage('SQL copied.'); }}>Copy</Button> : undefined}>
      {definition.encrypted ? <div className="dict-encrypted"><Badge tone="bad">Encrypted</Badge><p>The source stores this procedure encrypted (WITH ENCRYPTION), so its SQL cannot be read, searched or parsed. Its name and parameters are still listed.</p></div>
        : <>
          <p className="dict-note">{original !== null ? 'Original, fetched live from the source just now. It is not stored.' : 'Literal values hidden: strings and numbers are shown as placeholders.'}
            {definition.originalAvailable && (original === null ? <Button size="small" onClick={() => void showOriginal()}>Show original</Button> : <Button size="small" onClick={() => setOriginal(null)}>Hide original</Button>)}</p>
          {originalError && <p role="alert" className="error">{originalError}</p>}
          <pre className="dict-code">{highlightSql((original ?? definition.text ?? '').replace(/^\s*\n/, ''))}</pre>
        </>}
    </Section>}

    {(detail.columns.length > 0 || isTableLike) && <Section id="cols" title={detail.kind === 'sheet' ? 'Columns, with original headers' : detail.kind === 'datasource' ? 'Fields' : 'Columns'} open={props.isOpen('cols')} onToggle={props.toggle}
      aside={<>{keyColumns.length > 0 && <span className="dict-note">{showAll ? `${number(detail.columns.length)} columns` : `${number(keyColumns.length)} key ${keyColumns.length === 1 ? 'column' : 'columns'} of ${number(detail.columns.length)}`}</span>}{keyColumns.length > 0 && keyColumns.length < detail.columns.length && <Button size="small" onClick={() => setShowAll(!showAll)}>{showAll ? 'Key columns only' : `Show all ${number(detail.columns.length)}`}</Button>}</>}>
      {detail.columns.length ? <table className="dict-table"><thead><tr><th scope="col">#</th><th scope="col">Column</th><th scope="col">Type</th>{detail.columns.some((column) => column.label && column.label !== column.name) && <th scope="col">{detail.kind === 'sheet' ? 'Original header' : 'Label'}</th>}<th scope="col">Nulls</th><th scope="col">Distinct</th><th scope="col">Used by</th><th scope="col">From your data</th></tr></thead>
        <tbody>{shownColumns.map((column) => <tr key={column.name}>
          <td>{detail.columns.indexOf(column) + 1}</td>
          <td><span className="mono dict-colname">{column.name}</span>{column.key && <Badge>key</Badge>}{column.description && <p className="dict-col-desc">{column.description}</p>}
            {detail.tests.filter((test) => test.column === column.name).map((test) => <Badge key={test.test} tone="muted">{test.test}</Badge>)}</td>
          <td className="mono">{column.dataType ?? '—'}{column.nullable === false ? ' not null' : ''}</td>
          {detail.columns.some((item) => item.label && item.label !== item.name) && <td>{column.label && column.label !== column.name ? column.label : ''}</td>}
          <td>{column.statsWithheld ? <span title={column.withheldReason}>Withheld</span> : column.nullRate === null ? '—' : `${(column.nullRate * 100).toFixed(column.nullRate < 0.01 && column.nullRate > 0 ? 2 : 1)}%`}</td>
          <td>{column.statsWithheld ? <span title={column.withheldReason}>Withheld</span> : column.distinctCount === null ? '—' : number(column.distinctCount)}</td>
          <td>{column.usedBy ? `${number(column.usedBy)}` : '—'}</td>
          <td className="dict-cell-actions">{column.tags.map((tag) => <Badge key={tag} tone="bad">{tag === 'personal' ? 'Personal' : tag.toUpperCase()}</Badge>)}<Button size="small" onClick={() => props.navigate('/lineage/columns')}>Lineage</Button></td>
        </tr>)}</tbody></table> : <p>No columns recorded.</p>}
      {detail.columns.some((column) => column.statsWithheld) && <p className="dict-note">Withheld: tagged columns are never sampled, so their statistics are not collected.</p>}
    </Section>}
    {(isTableLike || detail.usedBy.length > 0) && <Section id="used" title={`Used by ${detail.usedBy.length}`} open={props.isOpen('used')} onToggle={props.toggle}>
      {detail.usedBy.length ? <ul className="dict-list">{detail.usedBy.map((item) => <li key={`${item.name}-${item.how}`}><button type="button" className="dict-name mono" onClick={() => item.source === detail.source.name && props.onOpen(item.name)}>{shortName(item.name)}</button> <span className="dict-note">{item.how}{item.source !== detail.source.name ? ` · ${item.source}` : ''}</span></li>)}</ul> : <p>Nothing in the graph reads this yet.</p>}
    </Section>}
    {isTableLike && detail.stats && <Section id="keys" title="Keys and indexes" open={props.isOpen('keys')} onToggle={props.toggle}>
      {detail.keys.length ? <ul className="dict-list">{detail.keys.map((key) => <li key={key.column}><span className="mono">{key.column}</span> → <button type="button" className="dict-name mono" onClick={() => props.onOpen(key.references.split('.').slice(0, -1).join('.'))}>{shortName(key.references)}</button> <Badge tone="good">Declared foreign key</Badge></li>)}</ul> : <p>No declared foreign keys.</p>}
      <p className="dict-note">Primary keys and indexes are not harvested yet.</p>
    </Section>}
    {isTableLike && detail.stats && <Section id="joins" title={`Joins to other tables ${detail.joins.length}`} open={props.isOpen('joins')} onToggle={props.toggle}>
      {detail.joins.length ? <table className="dict-table"><thead><tr><th scope="col">Column</th><th scope="col">Joins to</th><th scope="col">Evidence</th><th scope="col">Review</th></tr></thead>
        <tbody>{detail.joins.map((join) => <tr key={`${join.column}-${join.otherTable}-${join.otherColumn}`}><td className="mono">{join.column}</td><td><button type="button" className="dict-name mono" onClick={() => props.onOpen(join.otherTable)}>{shortName(join.otherTable)}</button>.<span className="mono">{join.otherColumn}</span></td>
          <td><span className={`evidence-chip evidence-${join.evidenceMethod}`}>{join.evidenceMethod}</span>{join.probable && <Badge tone="warn">Probable</Badge>}</td>
          <td>{join.reviewStatus === 'approved' ? 'Approved · still unverified' : join.reviewStatus.replaceAll('_', ' ')}{join.verification ? ` · ${join.verification.replaceAll('_', ' ')}` : ''}</td></tr>)}</tbody></table> : <p>No joins found.</p>}
    </Section>}
    {detail.tests.length > 0 && <Section id="tests" title={`dbt tests ${detail.tests.length}`} open={props.isOpen('tests')} onToggle={props.toggle}>
      <ul className="dict-list">{detail.tests.map((test) => <li key={`${test.column}-${test.test}`}><span className="mono">{test.column ?? 'model'}</span> · {test.test}</li>)}</ul>
    </Section>}
  </>;
}

function ExportNotice(props: { open: boolean; sources: Source[]; current: string; onClose: () => void; onDone: (message: string) => void }) {
  const [scope, setScope] = useState<'current' | 'all'>('current'); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function run() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/dictionary/export-html', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ acknowledged: true, ...(scope === 'current' ? { connectionIds: [props.current] } : {}) }) });
      if (!response.ok) throw new Error('export failed');
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'dictionary.html';
      const link = document.createElement('a'); link.href = URL.createObjectURL(await response.blob()); link.download = name; link.click(); URL.revokeObjectURL(link.href);
      props.onDone(`Exported ${name}. The export is recorded in the audit log.`);
    } catch { setError('The dictionary could not be exported.'); } finally { setBusy(false); }
  }
  return <Modal title="Export as interactive HTML" open={props.open} onClose={props.onClose}>
    <div className="dict-notice">
      <p>One HTML file you can open offline in any browser, with search, filters and expandable tables.</p>
      <p><strong>Included:</strong> names, types, descriptions, columns, keys and relationships, statistics shown in the product, and procedure and view SQL with literal values hidden.</p>
      <p><strong>Not included:</strong> row data, statistics withheld for sensitive columns, and original SQL. Out-of-scope objects are listed by name and type only.</p>
      <p>The file leaves Scale Insyght once downloaded, so share it as you would any internal document. Each export is recorded in the audit log.</p>
      <fieldset><legend>Sources</legend>
        <label><input type="radio" name="dict-export-scope" checked={scope === 'current'} onChange={() => setScope('current')} /> This source</label>
        {props.sources.length > 1 && <label><input type="radio" name="dict-export-scope" checked={scope === 'all'} onChange={() => setScope('all')} /> All {props.sources.length} sources</label>}
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="dict-actions"><Button variant="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Exporting…' : 'Export'}</Button><Button onClick={props.onClose}>Cancel</Button></div>
    </div>
  </Modal>;
}

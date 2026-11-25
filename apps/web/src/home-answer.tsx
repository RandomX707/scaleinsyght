import { useState, type ReactNode } from 'react';
import { Badge, Button, Table } from '@scaleinsyght/ui';

/**
 * How an answer is shown on Home (decision 56, docs/phases/home-chat.md). Code chooses the form from the result's
 * shape; the model only writes the answer sentence. Never a chart and a full table together by default.
 */
export type Row = { label: string; key: string; value: number | '<11' };
export type Form = 'sentence' | 'small_table' | 'chart' | 'compact_table' | 'lineage';
export type FormRequest = { form: 'table' | 'chart' | 'number' | 'all' | 'top' | 'bottom' | 'sort_name' | 'sort_value'; size?: number | null };
export const COMPACT_ROWS = 10;

export function toRows(rows: Array<Record<string, unknown>>): Row[] {
  return rows.map((row) => ({ label: String(row.group_value ?? ''), key: row.group_key == null ? '' : String(row.group_key), value: row.value === '<11' ? '<11' : Number(row.value) }));
}

/** Section 2: one value or one group → sentence; 2–5 → small table; 6–20 → chart; more than 20 → compact table. */
export function chooseForm(result: { rows?: unknown[] | undefined; lineage?: unknown }): Form {
  if (result.lineage) return 'lineage';
  const count = result.rows?.length ?? 0;
  if (count <= 1) return 'sentence';
  if (count <= 5) return 'small_table';
  if (count <= 20) return 'chart';
  return 'compact_table';
}

/** The form after a form-only follow-up, and the rows it shows. Order is always the query's order unless asked to sort. */
export function applyRequest(rows: Row[], request: FormRequest | null): { form: 'table' | 'chart' | 'compact_table' | 'small_table' | 'sentence' | null; rows: Row[] } {
  if (!request) return { form: null, rows };
  switch (request.form) {
    case 'table': case 'all': return { form: 'table', rows };
    case 'chart': return { form: 'chart', rows };
    case 'number': return { form: 'sentence', rows };
    case 'top': return { form: 'table', rows: rows.slice(0, request.size ?? rows.length) };
    case 'bottom': return { form: 'table', rows: rows.slice(-(request.size ?? rows.length)) };
    case 'sort_name': return { form: 'table', rows: [...rows].sort((a, b) => a.label.localeCompare(b.label)) };
    case 'sort_value': return { form: 'table', rows: [...rows].sort((a, b) => (b.value === '<11' ? -1 : b.value) - (a.value === '<11' ? -1 : a.value)) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Form-only follow-ups (section 5, approved addition b). Polite and filler words are removed; what remains must be
// exactly a form word. Anything else — a condition, a measure, a source, a new question — is not a form request, and
// the question runs normally. When the previous answer cannot be reshown that way, the result is null too.

const FILLER = new Set(['please', 'pls', 'can', 'could', 'would', 'will', 'you', 'just', 'show', 'me', 'give', 'put', 'make', 'display', 'turn',
  'it', 'that', 'this', 'those', 'these', 'them', 'the', 'a', 'an', 'as', 'in', 'into', 'instead', 'now', 'only', 'ok', 'okay', 'thanks', 'thank',
  'and', 'then', 'same', 'answer', 'result', 'results', 'one', 'again', 'form', 'format', 'view', 'i', 'want', 'see', 'like', 'to', 'of', 'us']);
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20 };

export type Previous = { scalar: boolean; rowCount: number; order: 'asc' | 'desc' | null; complete: boolean } | null;

export function recogniseFormRequest(text: string, previous: Previous): FormRequest | null {
  if (!previous || text.length > 120) return null;
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((word) => word && !FILLER.has(word));
  const rest = words.join(' ');
  const grouped = !previous.scalar && previous.rowCount > 1;
  if (/^(table|tabular|a table|grid)$/.test(rest)) return grouped ? { form: 'table' } : null;
  if (/^(bar )?(chart|graph|plot)$/.test(rest)) return grouped && previous.rowCount <= 100 ? { form: 'chart' } : null;
  if (/^(all|everything|every row|all rows|full list|full table|whole list|all of)$/.test(rest)) return grouped ? { form: 'all' } : null;
  if (/^(number|value|figure|count)$/.test(rest)) return previous.scalar ? { form: 'number' } : null;
  const ranked = /^(top|highest|biggest|largest|first|bottom|lowest|smallest|last) (\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twenty)$/.exec(rest);
  if (ranked) {
    const size = NUMBERS[ranked[2]!] ?? Number(ranked[2]);
    const high = ['top', 'highest', 'biggest', 'largest', 'first'].includes(ranked[1]!);
    // Only when the held rows are complete and ordered by value, so the subset is exactly what was asked.
    if (!grouped || !previous.complete || !previous.order || size < 1 || size >= previous.rowCount) return null;
    const fromStart = (high && previous.order === 'desc') || (!high && previous.order === 'asc');
    return { form: fromStart ? 'top' : 'bottom', size };
  }
  if (/^(sort(ed)? by name|sort(ed)? alphabetically|alphabetically|alphabetical order|a to z|by name)$/.test(rest)) return grouped ? { form: 'sort_name' } : null;
  if (/^(sort(ed)? by (value|count|size|number)|largest first|biggest first|highest first)$/.test(rest)) return grouped ? { form: 'sort_value' } : null;
  return null;
}

export function describeRequest(request: FormRequest): string {
  return { table: 'shown as a table', chart: 'shown as a chart', number: 'as a single number', all: 'with every row', top: `top ${request.size}`, bottom: `bottom ${request.size}`,
    sort_name: 'sorted by name', sort_value: 'sorted by value' }[request.form];
}

// ---------------------------------------------------------------------------------------------------------------
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

export function GroupChart(props: { rows: Row[]; sourceName: string; groupLabel: string }) {
  const numeric = props.rows.filter((row): row is Row & { value: number } => typeof row.value === 'number');
  const max = Math.max(...numeric.map((row) => row.value), 0);
  const withheld = props.rows.length - numeric.length;
  const highest = numeric.reduce<Row | null>((best, row) => !best || (row.value as number) > (best.value as number) ? row : best, null);
  const lowest = numeric.reduce<Row | null>((best, row) => !best || (row.value as number) < (best.value as number) ? row : best, null);
  const description = `Bar chart of ${props.rows.length} ${props.groupLabel.toLowerCase()} groups from ${props.sourceName}.${highest ? ` Highest ${highest.label} at ${number(highest.value as number)}; lowest ${lowest!.label} at ${number(lowest!.value as number)}.` : ''}${withheld ? ` ${withheld} ${withheld === 1 ? 'group is' : 'groups are'} withheld because fewer than 11 records were counted.` : ''}`;
  return <figure className="bar-chart" aria-label={description}><ul>{props.rows.map((row, index) => {
    const label = row.key && row.key !== row.label ? `${row.label} (${row.key})` : row.label;
    return <li key={`${row.label}-${index}`} className={`bar-row${row.value === '<11' ? ' is-withheld' : ''}`} tabIndex={0} aria-label={`${label}: ${row.value === '<11' ? 'fewer than 11, withheld' : number(row.value)}`}>
      <span className="bar-label">{label}</span>
      <span className="bar-track">{row.value !== '<11' && max > 0 && <span className="bar" style={{ width: `${Math.max(1, row.value / max * 100)}%` }} />}</span>
      <span className="bar-value">{row.value === '<11' ? '<11' : number(row.value)}</span>
    </li>;
  })}</ul>{withheld > 0 && <figcaption>Bars marked &lt;11 cover fewer than 11 records and are withheld to protect privacy.</figcaption>}</figure>;
}

export function GroupTable(props: { rows: Row[]; groupLabel: string; measureLabel: string; sourceName: string; compact?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = props.compact && !all ? props.rows.slice(0, COMPACT_ROWS) : props.rows;
  return <div className="answer-table">
    <Table caption={`${props.compact && !all ? `First ${shown.length} of ${props.rows.length}` : `${props.rows.length} rows`} from ${props.sourceName}`} headers={[props.groupLabel, props.measureLabel]}
      rows={shown.map((row) => [row.key && row.key !== row.label ? `${row.label} (${row.key})` : row.label, row.value === '<11' ? '<11' : number(row.value)])} />
    {props.compact && props.rows.length > COMPACT_ROWS && <Button size="small" aria-expanded={all} onClick={() => setAll(!all)}>{all ? `Show the first ${COMPACT_ROWS}` : `Show all ${props.rows.length.toLocaleString('en-US')}`}</Button>}
  </div>;
}

/** The display for one source's grouped result: the chosen form, plus a one-click switch to the other one. */
export function GroupedAnswer(props: { rows: Array<Record<string, unknown>>; request: FormRequest | null; sourceName: string; groupLabel: string; measureLabel: string; summary?: ReactNode }) {
  const base = toRows(props.rows);
  const requested = applyRequest(base, props.request);
  const chosen = requested.form ?? chooseForm({ rows: base });
  const [flip, setFlip] = useState<'table' | 'chart' | null>(null);
  const form = flip ?? chosen;
  const rows = requested.rows;
  return <div className="grouped-result">
    {props.summary}
    {form === 'chart' && <GroupChart rows={rows} sourceName={props.sourceName} groupLabel={props.groupLabel} />}
    {(form === 'table' || form === 'small_table') && <GroupTable rows={rows} groupLabel={props.groupLabel} measureLabel={props.measureLabel} sourceName={props.sourceName} />}
    {form === 'compact_table' && <GroupTable rows={rows} groupLabel={props.groupLabel} measureLabel={props.measureLabel} sourceName={props.sourceName} compact />}
    {chosen === 'chart' && <Button size="small" variant="ghost" onClick={() => setFlip(form === 'chart' ? 'table' : 'chart')}>{form === 'chart' ? 'Show as a table' : 'Show as a chart'}</Button>}
  </div>;
}

// ---------------------------------------------------------------------------------------------------------------
/** "Answered from SQL Server · 1 query · 8 s" (section 4). */
export function planSummary(input: { state: string; sources: string[]; steps: number; startedAt?: string | null; endedAt?: string | null; reason?: string | null; reasonText?: string | undefined }): string {
  const seconds = input.startedAt && input.endedAt ? Math.max(1, Math.round((Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 1000)) : null;
  const time = seconds === null ? '' : ` · ${seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`}`;
  if (!['COMPLETED', 'PARTIAL'].includes(input.state)) return `Not answered · ${input.reasonText ?? 'see details'}${time}`;
  const unique = [...new Set(input.sources)];
  const from = unique.length === 1 ? unique[0] : `${unique.length} sources`;
  const queries = `${input.steps} ${input.steps === 1 ? 'query' : 'queries'}`;
  return `${input.state === 'PARTIAL' ? 'Partly answered' : 'Answered'} from ${from} · ${queries}${time}`;
}

/** Refusals and failures: what happened and a safe next step (section 2, last row). Codes come from the run. */
export function refusalCopy(reason: string | undefined, objects: string[] | undefined): { title: string; explanation: string; alternative: { label: string; kind: 'ask' | 'controls' | 'retry'; question?: string } | null } {
  switch (reason) {
    case 'analytic_sensitive_column':
      return { title: 'Protected information', explanation: 'This question would show values from a column tagged as sensitive, so it was not run.',
        alternative: { label: 'Ask for a count instead', kind: 'ask', question: 'How many records are there, without listing names or identifiers?' } };
    case 'object_out_of_scope':
      return { title: 'Excluded in Controls', explanation: `${objects?.length ? `${objects.join(', ')} ${objects.length === 1 ? 'is' : 'are'} excluded in Controls` : 'This question reads data that is excluded in Controls'}, so it was not queried. An admin can change this in Controls.`,
        alternative: { label: 'Open Controls', kind: 'controls' } };
    case 'analytic_query_unsupported': case 'analytic_plan_rejected':
      return { title: 'Not a question I can answer yet', explanation: 'I can count records, add up a numeric column, compare sources and group by one column, with conditions; this question needs something else.',
        alternative: { label: 'Try a count or a breakdown', kind: 'ask', question: 'How many records are there, by one column?' } };
    case 'model_budget_exhausted': case 'daily_budget_exceeded':
      return { title: 'Daily budget reached', explanation: 'Today\'s model budget for your workspace or for you is used up, so this question was not planned.', alternative: null };
    case 'source_timeout': case 'source_query_executor_unavailable':
      return { title: 'The source did not respond', explanation: 'The source could not be reached or took too long. Nothing was changed.', alternative: { label: 'Try again', kind: 'retry' } };
    default:
      return { title: 'Not answered', explanation: 'I couldn’t answer this question from the selected sources.', alternative: { label: 'Try again', kind: 'retry' } };
  }
}

export function TrustBadges(props: { probableJoins: number }) {
  return <p className="answer-badges"><Badge tone="good">Evidence-backed · read-only</Badge>{props.probableJoins > 0 && <Badge tone="warn">Uses {props.probableJoins} probable {props.probableJoins === 1 ? 'link' : 'links'}</Badge>}</p>;
}

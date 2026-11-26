/**
 * Notifications and the Home "While you were away" cards (bug 4): each names its source, says what changed with a time,
 * and links to the details. Repeated items (the same kind from the same source) are grouped into one card with their
 * counts added up. Everything here is counts by kind; no names or values.
 */
export type Counts = { total: number; tablesChanged: number; tablesDropped: number; newTables: number; newColumns: number; removedColumns: number; retypedColumns: number;
  rowCountChanges: number; countsUnavailable: number; sensitiveColumns: number; probableRelationships: number; idMatches: number };
export type NotificationItem = { notificationId: string; type: string; summary: Record<string, unknown>; readAt: string | null; createdAt?: string;
  connectionId?: string | null; sourceName?: string | null; counts?: Counts };
export type NotificationGroup = { key: string; ids: string[]; unread: boolean; type: string; source: string; line: string; detail: string; when: string; latestAt: string | null; href: string; runs: number };

const ZERO: Counts = { total: 0, tablesChanged: 0, tablesDropped: 0, newTables: 0, newColumns: 0, removedColumns: 0, retypedColumns: 0, rowCountChanges: 0, countsUnavailable: 0, sensitiveColumns: 0, probableRelationships: 0, idMatches: 0 };
const n = (value: number) => value.toLocaleString('en-US');
const count = (value: number, one: string, many: string) => `${n(value)} ${value === 1 ? one : many}`;

/** What changed, most structural first: "2 tables changed, 1 new column". */
export function changeParts(counts: Counts): string[] {
  const parts: string[] = [];
  if (counts.tablesChanged) parts.push(count(counts.tablesChanged, 'table changed', 'tables changed'));
  if (counts.newColumns) parts.push(count(counts.newColumns, 'new column', 'new columns'));
  if (counts.removedColumns) parts.push(count(counts.removedColumns, 'column removed', 'columns removed'));
  if (counts.retypedColumns) parts.push(count(counts.retypedColumns, 'column type changed', 'column types changed'));
  if (counts.newTables) parts.push(count(counts.newTables, 'new table', 'new tables'));
  if (counts.tablesDropped) parts.push(count(counts.tablesDropped, 'table dropped', 'tables dropped'));
  if (counts.rowCountChanges) parts.push(count(counts.rowCountChanges, 'unusual row-count change', 'unusual row-count changes'));
  if (counts.countsUnavailable) parts.push(count(counts.countsUnavailable, 'table could not be counted', 'tables could not be counted'));
  if (counts.sensitiveColumns) parts.push(count(counts.sensitiveColumns, 'possible sensitive column', 'possible sensitive columns'));
  if (counts.probableRelationships) parts.push(count(counts.probableRelationships, 'probable relationship', 'probable relationships'));
  if (counts.idMatches) parts.push(count(counts.idMatches, 'possible ID match', 'possible ID matches'));
  return parts;
}

/** "Today, 14:04", "Yesterday, 02:10" or "24 Nov, 14:04", in the viewer's time zone. */
export function whenLabel(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso); const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
}

const KIND: Record<string, string> = { nightly: 'Nightly refresh', discovery: 'Profiling finished', report_impact: 'Report affected' };

function add(a: Counts, b: Counts | undefined): Counts {
  return Object.fromEntries((Object.keys(ZERO) as Array<keyof Counts>).map((key) => [key, a[key] + (b?.[key] ?? 0)])) as Counts;
}

/** Groups repeated items: one card per source and kind, new and earlier kept apart; newest first. */
export function groupNotifications(items: NotificationItem[], now = new Date()): NotificationGroup[] {
  const groups = new Map<string, { items: NotificationItem[]; counts: Counts }>();
  for (const item of items) {
    const key = `${item.readAt ? 'read' : 'new'}:${item.type}:${item.connectionId ?? item.sourceName ?? item.notificationId}`;
    const group = groups.get(key) ?? { items: [], counts: { ...ZERO } };
    group.items.push(item); group.counts = add(group.counts, item.counts); groups.set(key, group);
  }
  return [...groups].map(([key, { items: members, counts }]) => {
    const first = members[0]!; const latestAt = members.map((item) => item.createdAt ?? '').sort().at(-1) || null;
    const source = first.sourceName || (typeof first.summary.sourceName === 'string' ? first.summary.sourceName : '') || 'A connected source';
    const parts = changeParts(counts);
    // A profile's size is the latest run's, not a sum: profiling the same 7 tables twice is still 7 tables.
    const latest = [...members].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]!;
    const profiled = Number(latest.summary.profiled ?? 0);
    const what = first.type === 'discovery' ? `profiling finished, ${count(profiled, 'table or view', 'tables and views')} profiled`
      : first.type === 'report_impact' ? 'a connected report may be affected by a change'
      : parts.length ? parts.join(', ') : 'changes found';
    const runs = members.length;
    const detail = [KIND[first.type] ?? 'Update', runs > 1 ? `${n(runs)} ${first.type === 'nightly' ? 'runs' : 'times'}` : ''].filter(Boolean).join(' · ');
    const href = first.type === 'discovery' && first.connectionId ? `/profile/${first.connectionId}` : first.type === 'report_impact' ? '/bi-reports' : '/approval-matrix';
    return { key, ids: members.map((item) => item.notificationId), unread: !first.readAt, type: first.type, source, line: `${source}: ${what}`, detail,
      when: `${runs > 1 ? 'Latest ' : ''}${whenLabel(latestAt, now)}`.trim(), latestAt, href, runs };
  }).sort((a, b) => Number(b.unread) - Number(a.unread) || (b.latestAt ?? '').localeCompare(a.latestAt ?? ''));
}

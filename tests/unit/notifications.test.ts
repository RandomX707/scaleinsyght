import { describe, expect, it } from 'vitest';
import { changeParts, groupNotifications, whenLabel, type Counts, type NotificationItem } from '../../apps/web/src/notifications.js';

// Bug 4: each notification names its source, says what changed with a time and links to the details; repeats group.
const zero: Counts = { total: 0, tablesChanged: 0, tablesDropped: 0, newTables: 0, newColumns: 0, removedColumns: 0, retypedColumns: 0, rowCountChanges: 0, countsUnavailable: 0, sensitiveColumns: 0, probableRelationships: 0, idMatches: 0 };
const now = new Date(2026, 10, 26, 16, 0);
const item = (over: Partial<NotificationItem> & { counts?: Partial<Counts> }): NotificationItem => ({ notificationId: Math.random().toString(36), type: 'nightly', summary: {}, readAt: null,
  createdAt: new Date(2026, 10, 26, 2, 14).toISOString(), connectionId: 'c1', sourceName: 'SQL Server hospital', ...over, counts: { ...zero, ...over.counts } });

describe('notification wording', () => {
  it('says what changed, structural changes first', () => {
    expect(changeParts({ ...zero, tablesChanged: 2, newColumns: 1 })).toEqual(['2 tables changed', '1 new column']);
    expect(changeParts({ ...zero, idMatches: 7, probableRelationships: 4, newTables: 1, rowCountChanges: 2 })).toEqual(['1 new table', '2 unusual row-count changes', '4 probable relationships', '7 possible ID matches']);
    expect(changeParts({ ...zero, newColumns: 1200 })).toEqual(['1,200 new columns']);
  });
  it('gives the time plainly', () => {
    expect(whenLabel(new Date(2026, 10, 26, 2, 14).toISOString(), now)).toBe('Today, 02:14');
    expect(whenLabel(new Date(2026, 10, 25, 23, 5).toISOString(), now)).toBe('Yesterday, 23:05');
    expect(whenLabel(new Date(2026, 10, 24, 14, 4).toISOString(), now)).toBe('24 Nov, 14:04');
  });
  it('names the source and what changed, with a link to the details', () => {
    const [group] = groupNotifications([item({ counts: { total: 3, tablesChanged: 2, newColumns: 1 } })], now);
    expect(group).toMatchObject({ line: 'SQL Server hospital: 2 tables changed, 1 new column', detail: 'Nightly refresh', when: 'Today, 02:14', href: '/approval-matrix', unread: true });
    const [discovery] = groupNotifications([item({ type: 'discovery', connectionId: 'c9', sourceName: 'Operations workbook', summary: { profiled: 4 } })], now);
    expect(discovery).toMatchObject({ line: 'Operations workbook: profiling finished, 4 tables and views profiled', href: '/profile/c9' });
    // Profiling the same source twice reports the latest run's size, not a sum.
    const [twice] = groupNotifications([
      item({ type: 'discovery', sourceName: 'pgs', summary: { profiled: 7 }, createdAt: new Date(2026, 10, 25, 7, 0).toISOString() }),
      item({ type: 'discovery', sourceName: 'pgs', summary: { profiled: 8 }, createdAt: new Date(2026, 10, 25, 7, 35).toISOString() }),
    ], now);
    expect(twice).toMatchObject({ line: 'pgs: profiling finished, 8 tables and views profiled', detail: 'Profiling finished · 2 times' });
  });
  it('groups repeated items from one source and kind, adding their counts, and keeps new and earlier apart', () => {
    const groups = groupNotifications([
      item({ createdAt: new Date(2026, 10, 24, 2, 0).toISOString(), counts: { total: 2, idMatches: 2 } }),
      item({ createdAt: new Date(2026, 10, 26, 2, 14).toISOString(), counts: { total: 3, idMatches: 3 } }),
      item({ connectionId: 'c2', sourceName: 'pgs', counts: { total: 1, newTables: 1 } }),
      item({ readAt: '2026-11-20T00:00:00Z', createdAt: new Date(2026, 10, 19, 2, 0).toISOString(), counts: { total: 1, idMatches: 1 } }),
    ], now);
    expect(groups.map((group) => [group.line, group.detail, group.when, group.unread, group.ids.length])).toEqual([
      ['SQL Server hospital: 5 possible ID matches', 'Nightly refresh · 2 runs', 'Latest Today, 02:14', true, 2],
      ['pgs: 1 new table', 'Nightly refresh', 'Today, 02:14', true, 1],
      ['SQL Server hospital: 1 possible ID match', 'Nightly refresh', '19 Nov, 02:00', false, 1],
    ]);
  });
});

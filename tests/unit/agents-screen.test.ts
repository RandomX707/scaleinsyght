import { expect, it } from 'vitest';
import { collatingGroups, governedRows } from '../../apps/web/src/agents.js';

it('shows each governed agent once, by its latest version, with the version that may run', () => {
  const rows = governedRows([
    { governedId: 'a', name: 'Weekly pack', version: 1, approvedBy: 'u1', lastRunAt: '2026-11-24T07:00:00Z' },
    { governedId: 'a', name: 'Weekly pack', version: 2, approvedBy: null, lastRunAt: '2026-11-24T07:00:00Z' },
    { governedId: 'b', name: 'Nightly check', version: 1, approvedBy: 'u2', lastRunAt: null },
  ]);
  expect(rows.map((row) => [row.name, row.version, row.pending, row.approvedVersion])).toEqual([['Weekly pack', 2, true, 1], ['Nightly check', 1, false, 1]]);
});

it('orders collating groups and their members by connection order, whatever order the rows arrive in', () => {
  const connection = (connectionId: string, displayName: string, status = 'active') => ({ connectionId, displayName, connectorType: 'postgres', status });
  const active = [connection('c-pg', 'PostgreSQL testbed'), connection('c-sql', 'SQL Server testbed'), connection('c-xl', 'Workbook')];
  const row = (groupId: string, connectionId: string) => ({ groupId, version: 1, connectionId, connectorType: 'postgres' });
  const groups = collatingGroups([row('g-b', 'c-sql'), row('g-b', 'c-pg'), row('g-a', 'c-xl'), row('g-c', 'c-gone')], active);
  expect(groups.map((group) => [group.groupId, group.members.map((member) => member.displayName)])).toEqual([
    ['g-b', ['PostgreSQL testbed', 'SQL Server testbed']], ['g-a', ['Workbook']]]);
});

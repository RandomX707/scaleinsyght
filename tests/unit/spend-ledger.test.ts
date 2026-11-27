import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ledgerLine, readStamp, recordSpend, runLabel, stamp, tallyPath } from '../../scripts/spend-ledger.js';

const at = new Date(2026, 10, 27, 9, 5);

it('formats one line per run and names the day file', () => {
  expect(tallyPath('/x/claude-spend-{date}.txt', at)).toBe('/x/claude-spend-2026-11-27.txt');
  expect(ledgerLine({ at, label: '#66 abc1234', costUsd: 0.47123, calls: 58, database: 'si_test_tb' })).toBe('09:05 · #66 abc1234 · 0.4712 · recorded (si_test_tb, 58 model calls)\n');
});

it('appends only when the run made model calls, and does nothing when the ledger is off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const template = join(dir, 'spend-{date}.txt');
  expect(recordSpend({ template: undefined, at, label: 'x', costUsd: 1, calls: 3, database: 'si_test_tb' })).toBeNull();
  expect(recordSpend({ template, at, label: 'x', costUsd: 0, calls: 0, database: 'si_test_tb' })).toBeNull();
  expect(existsSync(tallyPath(template, at))).toBe(false);
  recordSpend({ template, at, label: 'one', costUsd: 0.5, calls: 10, database: 'si_test_tb' });
  recordSpend({ template, at, label: 'two', costUsd: 0.25, calls: 5, database: 'si_test_tb' });
  expect(readFileSync(tallyPath(template, at), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
});

it('labels a run by SPEND_LABEL when set', () => {
  expect(runLabel({ SPEND_LABEL: '#73' } as NodeJS.ProcessEnv)).toBe('#73');
});

it('a stamp written at creation names the run when its spend is recorded later', () => {
  expect(readStamp(stamp('#73 4567dc4', at))).toEqual({ label: '#73 4567dc4', startedAt: at });
  expect(readStamp(null)).toBeNull(); expect(readStamp('not json')).toBeNull(); expect(readStamp('{"other":1}')).toBeNull();
});

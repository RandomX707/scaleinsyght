import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const audit = readFileSync('docs/gap-audit.md', 'utf8');
const rows = audit.split('\n').filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line) && !/^\|\s*Item\s*\|/.test(line))
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));

describe('gap audit structure', () => {
  it('gap_audit_lists_each_item_once_with_a_known_status', () => {
    expect(rows.length).toBeGreaterThan(0);
    const items = rows.map((row) => row[0]!.toLowerCase());
    const duplicates = items.filter((item, index) => items.indexOf(item) !== index);
    expect(duplicates).toEqual([]);
    for (const row of rows) expect(['Real', 'Missing', 'Missing — untested'], row[0]).toContain(row[1]);
  });

  it('gap_audit_has_one_header_note_and_one_table', () => {
    expect(audit.split('\n').filter((line) => line.startsWith('>'))).toHaveLength(1);
    expect(audit.split('\n').filter((line) => /^\|\s*-/.test(line))).toHaveLength(1);
  });

  it('gap_audit_real_rows_name_an_existing_test', () => {
    for (const row of rows.filter((item) => item[1] === 'Real')) {
      const tests = [...row[2]!.matchAll(/`(tests\/[^`]+\.ts)`/g)].map((match) => match[1]!);
      expect(tests.length, row[0]).toBeGreaterThan(0);
      for (const path of tests) expect(existsSync(path), `${row[0]}: ${path}`).toBe(true);
    }
  });
});

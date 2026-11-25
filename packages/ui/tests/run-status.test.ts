import { describe, expect, it } from 'vitest';
import { answerTitle, plural, runStatusLabel } from '../src/run-status.js';

describe('Home run status', () => {
  it('run_status_label_follows_the_runner_states', () => {
    expect(runStatusLabel('PLANNING', [])).toBe('Planning');
    expect(runStatusLabel('RUNNING', ['SQL Server hospital'])).toBe('Querying SQL Server hospital');
    expect(runStatusLabel('RUNNING', ['SQL Server hospital', 'PostgreSQL testbed', 'SQL Server hospital'])).toBe('Querying SQL Server hospital and PostgreSQL testbed');
    expect(runStatusLabel('FINALISING', ['SQL Server hospital'])).toBe('Writing answer');
    expect(runStatusLabel('COMPLETED', [])).toBe('Completed');
    expect(runStatusLabel('FAILED', [])).toBe('Could not complete');
  });
  it('copy_uses_singular_and_plural_and_titles_answers_from_the_question', () => {
    expect(plural(1, 'read-only step')).toBe('1 read-only step');
    expect(plural(2, 'read-only step')).toBe('2 read-only steps');
    expect(plural(1, 'new update')).toBe('1 new update');
    expect(plural(1200, 'new update')).toBe('1,200 new updates');
    expect(answerTitle('what are Orders per department?')).toBe('What are Orders per department');
    expect(answerTitle('x'.repeat(120))).toHaveLength(88);
  });
});

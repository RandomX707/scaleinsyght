import { describe, expect, it } from 'vitest';
import { runStatusLabel } from '../src/run-status.js';

describe('Home run status', () => {
  it('run_status_label_follows_the_runner_states', () => {
    expect(runStatusLabel('PLANNING', [])).toBe('Planning');
    expect(runStatusLabel('RUNNING', ['SQL Server hospital'])).toBe('Querying SQL Server hospital');
    expect(runStatusLabel('RUNNING', ['SQL Server hospital', 'PostgreSQL testbed', 'SQL Server hospital'])).toBe('Querying SQL Server hospital and PostgreSQL testbed');
    expect(runStatusLabel('FINALISING', ['SQL Server hospital'])).toBe('Writing answer');
    expect(runStatusLabel('COMPLETED', [])).toBe('Completed');
    expect(runStatusLabel('FAILED', [])).toBe('Could not complete');
  });
});

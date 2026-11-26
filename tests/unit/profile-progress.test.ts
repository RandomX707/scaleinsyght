import { describe, expect, it } from 'vitest';
import { profileProgress } from '../../apps/web/src/profile-progress.js';
import { errorCopy } from '../../apps/web/src/error-copy.js';

// Decision 57: the Profile page shows a discovery job's real progress, and errors reach people in plain language.
describe('profile progress', () => {
  const states = (job: Parameters<typeof profileProgress>[0]) => profileProgress(job).steps.map((step) => step.state);
  it('moves through queued, listing, profiling and relationships from the job the worker writes', () => {
    expect(profileProgress({ state: 'QUEUED', phase: 'queued' })).toMatchObject({ percent: 0, running: true, complete: false });
    expect(states({ state: 'QUEUED', phase: 'queued' })).toEqual(['now', 'todo', 'todo', 'todo']);
    expect(profileProgress({ state: 'RUNNING', phase: 'listing' }).percent).toBe(5);
    const half = profileProgress({ state: 'RUNNING', phase: 'profiling', planned_count: 1200, profiled_count: 600 });
    expect(half.percent).toBe(50);
    expect(half.steps.map((step) => step.state)).toEqual(['done', 'done', 'now', 'todo']);
    expect(half.steps[2]!.label).toBe('Profiling tables, views and columns: 600 of 1,200 objects');
    expect(profileProgress({ state: 'RUNNING', phase: 'relationships', planned_count: 3, profiled_count: 3 }).percent).toBe(92);
  });
  it('is green and complete at the end, including jobs written before background profiling', () => {
    expect(profileProgress({ state: 'COMPLETED', phase: 'done' })).toMatchObject({ percent: 100, running: false, complete: true, message: null });
    expect(states({ state: 'COMPLETED', phase: null })).toEqual(['done', 'done', 'done', 'done']);
  });
  it('explains a stopped profile in plain words, never by code', () => {
    const failed = profileProgress({ state: 'FAILED', phase: 'profiling', planned_count: 10, profiled_count: 4, failure_code: 'discovery_failed' });
    expect(failed).toMatchObject({ failed: true, running: false });
    expect(failed.steps.map((step) => step.state)).toEqual(['done', 'done', 'failed', 'todo']);
    expect(failed.message).toBe('Profiling could not finish. Check that the source is reachable, then run the profile again from Connectors.');
    expect(profileProgress({ state: 'PARTIAL', phase: 'relationships' }).message).toMatch(/^The tables and columns were profiled/);
    expect(profileProgress({ state: 'FAILED', phase: 'listing', failure_code: 'discovery_abandoned' }).message).not.toMatch(/_/);
  });
});

describe('error copy', () => {
  it('never shows a raw code', () => {
    expect(errorCopy('connection_draft_not_found')).toBe('This connection no longer exists. Refresh the page and add it again.');
    expect(errorCopy('postgres_connector_role_not_read_only')).toBe('This PostgreSQL login can change data. Use a read-only login.');
    for (const code of ['saved_question_not_found', 'invalid_schedule', 'query_required', 'gateway_lease_stale', 'something_new']) {
      expect(errorCopy(code)).not.toMatch(/_/);
      expect(errorCopy(code)).toMatch(/^[A-Z].*\.$/);
    }
    expect(errorCopy(undefined)).toBe('The request could not be completed. Try again.');
    expect(errorCopy('Workbook file not found, upload it again.')).toBe('Workbook file not found, upload it again.');
  });
});

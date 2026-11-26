import { describe, expect, it } from 'vitest';
import { profileProgress, profileStatus } from '../../apps/web/src/profile-progress.js';
import { isObjectError, sourceErrorCode } from '@scaleinsyght/profiler';
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
    // K13: the ID agent's steps move the ring from 90% to 99% and show on the last step.
    const ids = profileProgress({ state: 'RUNNING', phase: 'relationships', planned_count: 3, profiled_count: 3, id_steps_planned: 80, id_steps_done: 20 });
    expect(ids.percent).toBe(92);
    expect(ids.steps[3]).toEqual({ label: 'Mapping relationships, lineage and IDs: IDs 25% done', state: 'now' });
    expect(profileProgress({ state: 'RUNNING', phase: 'relationships', id_steps_planned: 80, id_steps_done: 80 }).percent).toBe(99);
  });
  it('is green and complete at the end, including jobs written before background profiling', () => {
    expect(profileProgress({ state: 'COMPLETED', phase: 'done' })).toMatchObject({ percent: 100, running: false, complete: true, message: null });
    expect(states({ state: 'COMPLETED', phase: null })).toEqual(['done', 'done', 'done', 'done']);
  });
  it('explains a stopped profile in plain words, never by code', () => {
    const failed = profileProgress({ state: 'FAILED', phase: 'profiling', planned_count: 10, profiled_count: 4, failure_code: 'discovery_failed' });
    expect(failed).toMatchObject({ failed: true, running: false });
    expect(failed.steps.map((step) => step.state)).toEqual(['done', 'done', 'failed', 'todo']);
    expect(failed.message).toBe('Profiling could not finish. Check that the source is reachable, then retry.');
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

// Bug 6: a failed profile says why and what to do; one slow table never fails the profile.
describe('profile failures and notes', () => {
  it('names the cause of a failed profile and the fix, never a code', () => {
    expect(profileProgress({ state: 'FAILED', phase: 'listing', failure_code: 'source_ssl_not_supported' }).message)
      .toBe('The server doesn’t accept encrypted connections. Remove this connection and add it again with SSL mode set to Disable, if your network allows it.');
    for (const code of ['source_ssl_required', 'source_certificate_rejected', 'source_login_failed', 'source_database_not_found', 'source_unreachable', 'source_permission_denied', 'source_query_timeout', 'discovery_abandoned', 'anything_else'])
      expect(profileProgress({ state: 'FAILED', phase: 'listing', failure_code: code }).message).not.toMatch(/_/);
  });
  it('explains what a completed profile could not do fully', () => {
    expect(profileProgress({ state: 'COMPLETED', phase: 'done', limited_count: 9, failed_count: 1 }).notes).toEqual([
      '9 large tables were profiled without statistics or sensitivity samples, because the source took too long to scan them. Their columns and row counts are recorded.',
      '1 object could not be read and was skipped. Check the login’s permissions, then run the profile again.',
    ]);
    expect(profileProgress({ state: 'COMPLETED', phase: 'done' }).notes).toEqual([]);
  });
  it('gives the connector card an honest status and offers a profile only when none is open', () => {
    expect(profileStatus({ state: null })).toMatchObject({ badge: 'Profile needed', line: 'Last profile: not run yet', canRun: true });
    expect(profileStatus({ state: 'RUNNING' })).toMatchObject({ badge: 'Profiling', canRun: false });
    expect(profileStatus({ state: 'QUEUED' })).toMatchObject({ badge: 'Profile queued', canRun: false });
    expect(profileStatus({ state: 'FAILED', at: '2026-11-26T12:00:00Z' })).toMatchObject({ badge: 'Profile failed', tone: 'bad', canRun: true });
    expect(profileStatus({ state: 'COMPLETED', at: '2026-11-26T12:00:00Z', limited: 9 }).line).toMatch(/^Last profile: completed .+, with notes$/);
  });
  it('turns source errors into reason codes, and only object errors let a profile carry on', () => {
    expect(sourceErrorCode(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toBe('source_query_timeout');
    expect(sourceErrorCode(new Error('The server does not support SSL connections'))).toBe('source_ssl_not_supported');
    expect(sourceErrorCode(Object.assign(new Error('no pg_hba.conf entry for host "h", user "u", database "d", no encryption'), { code: '28000' }))).toBe('source_ssl_required');
    expect(sourceErrorCode(Object.assign(new Error('password authentication failed for user "u"'), { code: '28P01' }))).toBe('source_login_failed');
    expect(sourceErrorCode(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' }))).toBe('source_unreachable');
    expect(sourceErrorCode(Object.assign(new Error('permission denied for table t'), { code: '42501' }))).toBe('source_permission_denied');
    expect(sourceErrorCode(new Error('postgres_connector_role_not_read_only'))).toBe('postgres_connector_role_not_read_only');
    expect(sourceErrorCode(new Error('something odd with host db.internal'))).toBe('discovery_failed');
    expect(isObjectError('source_query_timeout')).toBe(true);
    expect(isObjectError('source_unreachable')).toBe(false);
    expect(isObjectError('source_login_failed')).toBe(false);
  });
});


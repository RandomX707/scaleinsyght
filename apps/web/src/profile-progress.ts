/**
 * Live progress of a connector's discovery profile (decision 57; bug 6), in the prototype's form: a ring that is orange
 * while profiling and green when complete, and a step list. Every figure comes from the job row the worker writes;
 * nothing is simulated. A failed job says why in plain words and what to do.
 */
export type ProfileJob = {
  state: string; phase?: string | null; listed_count?: number | null; planned_count?: number | null; profiled_count?: number | null;
  failure_code?: string | null; limited_count?: number | null; failed_count?: number | null; id_steps_planned?: number | null; id_steps_done?: number | null; id_fields_skipped?: number | null;
};
export type StepState = 'done' | 'now' | 'todo' | 'failed';

const STEPS = [
  { phase: 'queued', label: 'Waiting for a profiler to start' },
  { phase: 'listing', label: 'Reading the information schema' },
  { phase: 'profiling', label: 'Profiling tables, views and columns' },
  { phase: 'relationships', label: 'Mapping relationships, lineage and IDs' },
] as const;

const running = (job: ProfileJob) => job.state === 'QUEUED' || job.state === 'RUNNING';
const n = (value: number) => value.toLocaleString('en-US');

/** The phase a job is in. Jobs written before background profiling have no phase; they are finished. */
function phaseOf(job: ProfileJob): string { return job.phase ?? (running(job) ? 'queued' : 'done'); }

export function profileProgress(job: ProfileJob) {
  const phase = phaseOf(job);
  const planned = Math.max(0, Number(job.planned_count ?? 0)); const profiled = Math.min(planned, Math.max(0, Number(job.profiled_count ?? 0)));
  const failed = job.state === 'FAILED' || job.state === 'PARTIAL' || job.state === 'CANCELLED';
  const percent = job.state === 'COMPLETED' ? 100
    : phase === 'queued' ? 0 : phase === 'listing' ? 5
    : phase === 'profiling' ? 10 + Math.floor((planned ? profiled / planned : 1) * 80)
    : phase === 'relationships' ? 90 + (Number(job.id_steps_planned ?? 0) ? Math.floor(9 * Math.min(1, Number(job.id_steps_done ?? 0) / Number(job.id_steps_planned))) : 2) : 100;
  const current = STEPS.findIndex((step) => step.phase === phase);
  const steps = STEPS.map((step, index) => {
    const state: StepState = job.state === 'COMPLETED' || current === -1 || index < current ? 'done' : index === current ? (failed ? 'failed' : running(job) ? 'now' : 'done') : 'todo';
    const label = step.phase === 'profiling' && planned && (state === 'now' || state === 'done' || state === 'failed')
      ? `${step.label}: ${n(profiled)} of ${n(planned)} ${planned === 1 ? 'object' : 'objects'}`
      : step.phase === 'relationships' && state === 'now' && Number(job.id_steps_planned ?? 0) > 0
        ? `${step.label}: IDs ${Math.floor((100 * Math.min(1, Number(job.id_steps_done ?? 0) / Number(job.id_steps_planned))))}% done` : step.label;
    return { label, state };
  });
  return { percent, running: running(job), complete: job.state === 'COMPLETED', failed, steps, message: failed ? failureCopy(job) : null, notes: job.state === 'COMPLETED' ? completionNotes(job) : [] };
}

/** What a completed profile could not do fully, in plain words. */
export function completionNotes(job: ProfileJob): string[] {
  const notes: string[] = []; const limited = Number(job.limited_count ?? 0); const unread = Number(job.failed_count ?? 0);
  if (limited) notes.push(`${n(limited)} large ${limited === 1 ? 'table was' : 'tables were'} profiled without statistics or sensitivity samples, because the source took too long to scan ${limited === 1 ? 'it' : 'them'}. ${limited === 1 ? 'Its' : 'Their'} columns and row counts are recorded.`);
  const idsSkipped = Number(job.id_fields_skipped ?? 0);
  if (idsSkipped) notes.push(`${n(idsSkipped)} ID ${idsSkipped === 1 ? 'field was' : 'fields were'} too large to read in time and ${idsSkipped === 1 ? 'was' : 'were'} skipped; earlier ID matches for ${idsSkipped === 1 ? 'it are' : 'them are'} kept.`);
  if (unread) notes.push(`${n(unread)} ${unread === 1 ? 'object' : 'objects'} could not be read and ${unread === 1 ? 'was' : 'were'} skipped. Check the login’s permissions, then run the profile again.`);
  return notes;
}

/** Plain-language reasons with what to do; a code never reaches the screen. */
export function failureCopy(job: ProfileJob): string {
  if (job.state === 'PARTIAL') return 'The tables and columns were profiled, but relationships and lineage could not be mapped. Retry the profile.';
  if (job.state === 'CANCELLED') return 'This profile was stopped because the connection was removed.';
  switch (job.failure_code) {
    case 'source_ssl_not_supported': return 'The server doesn’t accept encrypted connections. Remove this connection and add it again with SSL mode set to Disable, if your network allows it.';
    case 'source_ssl_required': return 'The server only accepts encrypted connections. Remove this connection and add it again with SSL mode set to Require.';
    case 'source_certificate_rejected': return 'The server’s certificate couldn’t be verified. Ask your database administrator for a trusted certificate, or add the connection again with SSL mode set to Require instead of Verify full.';
    case 'source_login_failed': return 'The database rejected the user name or password. Check the login, then remove and add the connection again.';
    case 'source_database_not_found': return 'The database name wasn’t found on the server. Check the name, then add the connection again.';
    case 'source_unreachable': return 'The server couldn’t be reached. Check the host, the port and that the server allows connections from this network, then retry.';
    case 'source_permission_denied': return 'The login isn’t allowed to read these tables. Grant it read access to the schemas you want profiled, then retry.';
    case 'source_query_timeout': return 'The source took too long to answer. Retry when it is less busy, or narrow the scope in Controls.';
    case 'discovery_abandoned': return 'Profiling stopped several times before it could finish. Check that the source is reachable, then retry.';
    case 'postgres_connector_role_not_read_only': case 'sqlserver_connector_role_not_read_only': return 'The database login can change data. Use a read-only login, then add the connection again.';
    case 'artifact_file_missing': return 'The workbook file was not found. Upload it again.';
    default: return 'Profiling could not finish. Check that the source is reachable, then retry.';
  }
}

/** The connector card's profile status and whether a profile can be started now. */
export function profileStatus(last: { state: string | null; at?: string | null; failure?: string | null; failed?: number | null; limited?: number | null }) {
  const when = last.at ? new Date(last.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  switch (last.state) {
    case 'QUEUED': return { badge: 'Profile queued', tone: 'warn' as const, line: 'Last profile: waiting to start', canRun: false };
    case 'RUNNING': return { badge: 'Profiling', tone: 'warn' as const, line: 'Last profile: running now', canRun: false };
    case 'COMPLETED': return { badge: 'Profiled', tone: 'primary' as const, line: `Last profile: completed ${when}`.trim() + (Number(last.failed ?? 0) || Number(last.limited ?? 0) ? ', with notes' : ''), canRun: true };
    case 'FAILED': return { badge: 'Profile failed', tone: 'bad' as const, line: `Last profile: failed ${when}`.trim(), canRun: true };
    case 'PARTIAL': return { badge: 'Profiled with gaps', tone: 'warn' as const, line: `Last profile: relationships not mapped ${when}`.trim(), canRun: true };
    default: return { badge: 'Profile needed', tone: 'warn' as const, line: 'Last profile: not run yet', canRun: true };
  }
}

/**
 * Live progress of a connector's discovery profile (decision 57), in the prototype's form: a ring that is orange while
 * profiling and green when complete, and a step list. Every figure comes from the job row the worker writes; nothing is
 * simulated.
 */
export type ProfileJob = {
  state: string; phase?: string | null; listed_count?: number | null; planned_count?: number | null; profiled_count?: number | null;
  failure_code?: string | null;
};
export type StepState = 'done' | 'now' | 'todo' | 'failed';

const STEPS = [
  { phase: 'queued', label: 'Waiting for a profiler to start' },
  { phase: 'listing', label: 'Reading the information schema' },
  { phase: 'profiling', label: 'Profiling tables, views and columns' },
  { phase: 'relationships', label: 'Mapping relationships, lineage and IDs' },
] as const;

const running = (job: ProfileJob) => job.state === 'QUEUED' || job.state === 'RUNNING';

/** The phase a job is in. Jobs written before background profiling have no phase; they are finished. */
function phaseOf(job: ProfileJob): string { return job.phase ?? (running(job) ? 'queued' : 'done'); }

export function profileProgress(job: ProfileJob) {
  const phase = phaseOf(job);
  const planned = Math.max(0, Number(job.planned_count ?? 0)); const profiled = Math.min(planned, Math.max(0, Number(job.profiled_count ?? 0)));
  const failed = job.state === 'FAILED' || job.state === 'PARTIAL' || job.state === 'CANCELLED';
  const percent = job.state === 'COMPLETED' ? 100
    : phase === 'queued' ? 0 : phase === 'listing' ? 5
    : phase === 'profiling' ? 10 + Math.floor((planned ? profiled / planned : 1) * 80)
    : phase === 'relationships' ? 92 : 100;
  const current = STEPS.findIndex((step) => step.phase === phase);
  const steps = STEPS.map((step, index) => {
    const state: StepState = job.state === 'COMPLETED' || current === -1 || index < current ? 'done' : index === current ? (failed ? 'failed' : running(job) ? 'now' : 'done') : 'todo';
    const label = step.phase === 'profiling' && planned && (state === 'now' || state === 'done' || state === 'failed')
      ? `${step.label}: ${profiled.toLocaleString('en-US')} of ${planned.toLocaleString('en-US')} ${planned === 1 ? 'object' : 'objects'}` : step.label;
    return { label, state };
  });
  return { percent, running: running(job), complete: job.state === 'COMPLETED', failed, steps, message: failed ? failureCopy(job) : null };
}

/** Plain-language reasons; a code never reaches the screen. */
export function failureCopy(job: ProfileJob): string {
  if (job.state === 'PARTIAL') return 'The tables and columns were profiled, but relationships and lineage could not be mapped. Run the profile again from Connectors.';
  switch (job.failure_code) {
    case 'discovery_abandoned': return 'Profiling stopped several times before it could finish. Check that the source is reachable, then run the profile again.';
    case 'postgres_connector_role_not_read_only': case 'sqlserver_connector_role_not_read_only': return 'The database login can change data. Use a read-only login, then run the profile again.';
    case 'artifact_file_missing': return 'The workbook file was not found. Upload it again.';
    default: return 'Profiling could not finish. Check that the source is reachable, then run the profile again from Connectors.';
  }
}

// Live status shown on the Home plan card while a run moves through the durable runner.
export function listNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function runStatusLabel(state: string, sourceNames: string[]): string {
  switch (state) {
    case 'COMPLETED': return 'Completed';
    case 'POLICY_BLOCKED': return 'Needs review';
    case 'FAILED': return 'Could not complete';
    case 'PARTIAL': return 'Incomplete';
    case 'CREATED': case 'PLANNING': case 'PLAN_VALIDATED': return 'Planning';
    case 'RUNNING': return sourceNames.length ? `Querying ${listNames([...new Set(sourceNames)])}` : 'Querying';
    case 'FINALISING': return 'Writing answer';
    default: return 'In progress';
  }
}

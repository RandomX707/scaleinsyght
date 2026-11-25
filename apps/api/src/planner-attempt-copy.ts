export function plannerAttemptSummary(error: unknown): string {
  if (typeof error !== 'string') return 'Plan accepted.';
  const blocked = /^grouping_by_a_sensitive_column_is_not_allowed: ([\w.$]+) is tagged ([\w ,]+)$/.exec(error);
  if (blocked) {
    const field = blocked[1]!.split('.').at(-1);
    const description = blocked[2]!.includes('identifier') ? 'a sensitive identifier' : 'a sensitive column';
    return `Blocked because the question would expose ${field}, ${description}.`;
  }
  if (error.startsWith('verification_failed:')) return 'The proposed plan did not answer the question.';
  if (error === 'analytic_query_unsupported') return 'The catalog or supported query types could not answer the question.';
  return 'The proposed plan failed validation.';
}

export function publicPlannerDetails(plan: unknown, admin: boolean) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { summaries: [] };
  const details = plan as {error?:unknown;attempts?:Array<{error?:unknown;purpose?:string}>;source_selection?:unknown};
  const attempts = Array.isArray(details.attempts) ? details.attempts.filter(attempt => attempt.purpose !== 'verify') : [details];
  return {
    summaries: attempts.map(attempt => plannerAttemptSummary(attempt.error)),
    typedPlan: admin ? plan : {source_selection:details.source_selection},
  };
}

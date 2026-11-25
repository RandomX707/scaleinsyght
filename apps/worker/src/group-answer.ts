/** Attach a disclosed label locally, without sending group values to the model.
 * Add ranking language only when the executed plan ordered one result by value.
 */
export function nameSingleGroup(
  statement: string,
  row: {group_value?: unknown;value?: unknown} | undefined,
  question: string,
  intent: {order?: unknown;limit?: unknown;orderBy?: unknown} | undefined,
): string {
  const label = row?.group_value;
  if (typeof label !== 'string' || !label.trim()) return statement;
  if (statement.includes(label)) return statement;
  const rank = question.match(/\b(fewest|most|least) ([a-z]+)\b/i);
  const value = Number(row?.value);
  const ascending = rank && rank[1]!.toLowerCase() !== 'most';
  if (rank && intent?.limit === 1 && intent.order === (ascending ? 'asc' : 'desc')
    && intent.orderBy !== 'group' && Number.isFinite(value)) {
    return `${label} had the ${rank[1]!.toLowerCase()} ${rank[2]!.toLowerCase()}: ${value.toLocaleString('en-US')}.`;
  }
  return `${label}: ${statement}`;
}

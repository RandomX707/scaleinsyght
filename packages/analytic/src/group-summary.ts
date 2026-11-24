// Deterministic summary of a grouped result. Computed in code so the model never does arithmetic;
// labels stay here and in the UI and are never sent to the model.
export interface GroupSummary {
  groupCount: number;
  highest: { label: string; value: number };
  lowest: { label: string; value: number };
  spread: number;
  ties: Array<{ value: number; labels: string[] }>;
}

export const roundForModel = (value: number): number => Number.isInteger(value) ? value : Math.round(value * 100) / 100;

export function summarizeGroups(rows: ReadonlyArray<Record<string, unknown>>): GroupSummary | undefined {
  const groups = rows.filter((row) => 'group_value' in row).map((row) => ({ label: String(row.group_value ?? ''), value: Number(row.value) }));
  if (groups.length < 2 || groups.some((group) => !Number.isFinite(group.value))) return undefined;
  let highest = groups[0]!, lowest = groups[0]!;
  for (const group of groups) { if (group.value > highest.value) highest = group; if (group.value < lowest.value) lowest = group; }
  const byValue = new Map<number, string[]>();
  for (const group of groups) byValue.set(group.value, [...(byValue.get(group.value) ?? []), group.label]);
  const ties = [...byValue.entries()].filter(([, labels]) => labels.length > 1).map(([value, labels]) => ({ value: roundForModel(value), labels })).sort((left, right) => right.value - left.value);
  return { groupCount: groups.length, highest, lowest, spread: roundForModel(highest.value - lowest.value), ties };
}

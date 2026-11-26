/**
 * Copy detection (decision 62). A procedure or function whose normalised SQL is near-identical to another's is a
 * customer's copy of it: the later-created one is the copy. Works on the scrubbed definitions already stored (literals
 * are placeholders), so no data value is ever compared.
 */
export const COPY_SIMILARITY = 0.9;
const MIN_TOKENS = 20;

/** The routine's body, without comments, its CREATE header or its own name, lower case with single spaces. */
export function normaliseRoutine(text: string, qualifiedName: string): string {
  let body = text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const dollar = /\$([A-Za-z_]*)\$([\s\S]*)\$\1\$/.exec(body); // PostgreSQL: the body between $tag$ quotes
  if (dollar) body = dollar[2]!;
  else { const as = /\bAS\b/i.exec(body); if (as) body = body.slice(as.index + 2); } // SQL Server: after the header's AS
  const short = qualifiedName.replace(/\(.*$/, '').split('.').at(-1)!;
  for (const name of [qualifiedName.replace(/\(.*$/, ''), short]) body = body.split(name).join(' self ').split(name.toLowerCase()).join(' self ');
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

const tokens = (text: string) => text.match(/[a-z0-9_]+|[^\sa-z0-9_]/g) ?? [];
function shingles(text: string): Set<string> {
  const list = tokens(text); const out = new Set<string>();
  for (let index = 0; index + 2 < list.length; index++) out.add(`${list[index]} ${list[index + 1]} ${list[index + 2]}`);
  return out;
}

/** Dice similarity of two normalised bodies over three-token shingles. */
export function routineSimilarity(left: string, right: string): number {
  const a = shingles(left); const b = shingles(right);
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const item of a) if (b.has(item)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export type RoutineForCopies = { qualifiedName: string; text: string; createdOrder: number | null };

/** For each routine that is a near-identical copy of an earlier one: the original and the similarity. */
export function detectCopies(routines: RoutineForCopies[]): Map<string, { copyOf: string; similarity: number }> {
  const prepared = routines.map((routine) => ({ ...routine, body: normaliseRoutine(routine.text, routine.qualifiedName) }))
    .map((routine) => ({ ...routine, size: tokens(routine.body).length }))
    .filter((routine) => routine.size >= MIN_TOKENS)
    .sort((a, b) => a.size - b.size);
  const copies = new Map<string, { copyOf: string; similarity: number }>();
  for (let i = 0; i < prepared.length; i++) {
    const left = prepared[i]!;
    for (let j = i + 1; j < prepared.length && prepared[j]!.size <= left.size / COPY_SIMILARITY * 1.05; j++) {
      const right = prepared[j]!;
      const similarity = routineSimilarity(left.body, right.body);
      if (similarity < COPY_SIMILARITY) continue;
      // The later-created routine is the copy; without creation order, the one whose name sorts later.
      const leftLater = left.createdOrder !== null && right.createdOrder !== null ? left.createdOrder > right.createdOrder : left.qualifiedName > right.qualifiedName;
      const [copy, original] = leftLater ? [left, right] : [right, left];
      const current = copies.get(copy.qualifiedName);
      if (!current || similarity > current.similarity) copies.set(copy.qualifiedName, { copyOf: original.qualifiedName, similarity: Number(similarity.toFixed(3)) });
    }
  }
  return copies;
}

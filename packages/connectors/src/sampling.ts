/**
 * Profiling large tables (decision 59). A table's size comes first from the database's catalog statistics, which cost
 * nothing to read; it is counted exactly only when the catalog has no estimate or the table is small. Column statistics
 * and sensitivity samples read a bounded number of rows: all of a small table, or a TABLESAMPLE SYSTEM sample of a
 * large one with a fixed row cap. Every figure that comes from a sample or the catalog is marked as an estimate.
 */

/** Below this catalog estimate the row count is exact (count(*)); above it the catalog estimate is used. */
export const EXACT_COUNT_LIMIT = 1_000_000;
/** Column statistics read at most this many rows. */
export const STATISTICS_SAMPLE_ROWS = 100_000;
/** Sensitivity detection reads at most this many rows for all text columns together. */
export const SENSITIVITY_SAMPLE_ROWS = 2_000;
/** A text column with fewer non-null values than this in the shared sample gets its own non-null sample. */
export const SENSITIVITY_MIN_VALUES = 20;
/** Values per column handed to the sensitivity detector (decision 41: discarded after classification). */
export const SENSITIVITY_VALUES = 200;

/** The share of a table to sample so that about `wanted` rows come back (twice over, then capped with a row limit);
 * null when the whole table is small enough to read. TABLESAMPLE SYSTEM picks whole pages, so it oversamples. */
export function samplePercent(rows: number | null, wanted: number): number | null {
  if (rows === null || rows <= wanted) return null;
  return Math.min(100, Math.max(0.0001, Number(((wanted / rows) * 200).toPrecision(3))));
}

/** The catalog's row estimate, if it has one; PostgreSQL reports -1 for never analysed, 0 pages for an empty heap. */
export function catalogEstimate(tuples: number | null | undefined, pages?: number | null): number | null {
  if (tuples === null || tuples === undefined || !Number.isFinite(tuples) || tuples < 0) return null;
  if (pages !== undefined && pages !== null && pages <= 0 && tuples === 0) return null;
  return Math.round(tuples);
}

/** A distinct count from PostgreSQL's own statistics: positive is a count, negative is a share of the rows. */
export function distinctFromCatalog(nDistinct: number | null | undefined, rows: number | null): number | null {
  if (nDistinct === null || nDistinct === undefined || !Number.isFinite(nDistinct) || nDistinct === 0) return null;
  if (nDistinct > 0) return Math.round(nDistinct);
  return rows === null ? null : Math.round(-nDistinct * rows);
}

/** The limits a connector profiles with; tests lower them to exercise sampling on small tables. */
export type SamplingLimits = { exactCountLimit: number; statisticsSampleRows: number; sensitivitySampleRows: number };
export const DEFAULT_SAMPLING: SamplingLimits = { exactCountLimit: EXACT_COUNT_LIMIT, statisticsSampleRows: STATISTICS_SAMPLE_ROWS, sensitivitySampleRows: SENSITIVITY_SAMPLE_ROWS };

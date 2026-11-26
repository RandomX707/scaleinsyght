import { createHash } from 'node:crypto';

/**
 * Consistent ID sampling (decision 61). An identifier value is kept when a fixed rule on the value itself selects it,
 * so every source keeps the same values and two sampled fields can still be matched:
 *   - a plain positive integer (no sign, no leading zero, at most 18 digits) is kept when it is divisible by 16;
 *   - "0" is kept;
 *   - any other text is kept when the first hex digit of the MD5 of its UTF-8 bytes is 0.
 * About 1 value in 16 is kept either way. This function defines the kept set everywhere; the SQL forms below select the
 * same values in the source, used when a column is too large to read whole.
 */
export const ID_SAMPLE_MODULUS = 16;
/** A column with up to this many distinct values is kept whole; above it, the rule's sample is kept. */
export const ID_SAMPLE_MINIMUM_DISTINCT = 20_000;

const PLAIN_INTEGER = /^[1-9][0-9]{0,17}$/;

export function inIdSample(value: string): boolean {
  if (value === '0') return true;
  if (PLAIN_INTEGER.test(value)) return BigInt(value) % BigInt(ID_SAMPLE_MODULUS) === 0n;
  return createHash('md5').update(value, 'utf8').digest('hex')[0] === '0';
}

/** The same rule in PostgreSQL, over a text expression. */
export function postgresIdSampleCondition(text: string): string {
  return `(CASE WHEN ${text} = '0' THEN true WHEN ${text} ~ '^[1-9][0-9]{0,17}$' THEN (${text})::numeric % ${ID_SAMPLE_MODULUS} = 0 ELSE left(md5(${text}), 1) = '0' END)`;
}

/** The same rule in SQL Server, over an nvarchar expression. MD5 is taken over the varchar form, which equals UTF-8 for
 * ASCII text; the rule is checked again in code, so a non-ASCII value can only ever be left out, never added. */
export function sqlServerIdSampleCondition(text: string): string {
  return `(CASE WHEN ${text} = N'0' THEN 1 WHEN LEN(${text}) BETWEEN 1 AND 18 AND ${text} NOT LIKE N'%[^0-9]%' AND ${text} NOT LIKE N'0%' THEN CASE WHEN CAST(${text} AS decimal(38,0)) % ${ID_SAMPLE_MODULUS} = 0 THEN 1 ELSE 0 END WHEN LEFT(CONVERT(varchar(32), HASHBYTES('MD5', CAST(${text} AS varchar(400))), 2), 1) = '0' THEN 1 ELSE 0 END) = 1`;
}

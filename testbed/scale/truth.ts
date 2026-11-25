import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';

// Truth for testbed/scale/questions.json, computed by each question's reference SQL in a read-only transaction through
// the scale login. Run after testbed/scale/generate.ts.
config({ path: resolve('.env') });
type Question = { id: string; question: string; table: string; sql: string };
const questions = JSON.parse(readFileSync('testbed/scale/questions.json', 'utf8')) as Question[];
const client = new Client({ connectionString: process.env.DATABASE_URL_SCALE });
await client.connect();
const truth: Record<string, number | Array<{ label: string; value: number }>> = {};
try {
  await client.query('BEGIN READ ONLY');
  for (const item of questions) {
    const rows = (await client.query<{ label?: string; value: string }>(item.sql)).rows;
    truth[item.id] = / AS label\b/.test(item.sql) ? rows.map((row) => ({ label: String(row.label), value: Number(row.value) })) : Number(rows[0]!.value);
  }
  await client.query('ROLLBACK');
} finally { await client.end(); }
writeFileSync('testbed/scale/truth.json', `${JSON.stringify(truth, null, 2)}\n`);
process.stdout.write(`${Object.keys(truth).length} answers written to testbed/scale/truth.json\n`);

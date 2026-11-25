import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { config } from 'dotenv';
import { withTenant } from '@scaleinsyght/db';

export function readExecutedSql(pool: Pool, tenantId: string, runId: string): Promise<string[]> {
  return withTenant(pool, tenantId, async client => {
    const results = await client.query<{ locator: string }>(
      `SELECT evidence->>'locator' AS locator
       FROM runs.analytic_results r
       CROSS JOIN LATERAL jsonb_array_elements(r.result->'evidence') evidence
       WHERE r.tenant_id=$1 AND r.run_id=$2 AND evidence->>'kind'='query'
       ORDER BY r.step_id`, [tenantId, runId]);
    return results.rows.map(row => row.locator);
  });
}

// Backfill captured SQL for an existing local result without another model call.
if (process.argv[1]?.endsWith('/eval-planner-sql.ts')) {
  config();
  const file = process.argv[2];
  if (!file || !/^testbed\/eval\/results\/[\dTZ.-]+\.json$/.test(file)) throw new Error('Expected an evaluation result path');
  const result = JSON.parse(await readFile(file, 'utf8'));
  const database = new URL(process.env.DATABASE_URL_MIGRATE ?? '');
  if (!['localhost', '127.0.0.1'].includes(database.hostname)) throw new Error('Evaluation requires local si_test');
  database.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
  const pool = new Pool({connectionString: database.toString()});
  try {
    for (const set of result.sets) for (const item of set.results) for (const turn of item.turns) {
      if (turn.runId && !turn.sql?.length) turn.sql = await readExecutedSql(pool, result.tenantId, turn.runId);
    }
    await writeFile(file, JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
  } finally {
    await pool.end();
  }
}

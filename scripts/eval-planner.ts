import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { readExecutedSql } from './eval-planner-sql.js';
import { createTenant } from './tenant-create.js';
import type { Expected, Result, Source } from '../testbed/eval/collect-truth.js';

config();
if (process.env.CI || process.env.GITHUB_ACTIONS) throw new Error('Planner evaluation is local only');
const evalRoot = new URL('../testbed/eval/', import.meta.url);
const load = async (file: string) => JSON.parse(await readFile(new URL(file, evalRoot), 'utf8'));
const base = 'http://127.0.0.1:3340';
const started = new Date();
const output = new URL('results/' + started.toISOString().replaceAll(':', '-') + '.json', evalRoot);
const tenantId = 'planner-eval-' + randomUUID();
const email = tenantId + '@example.test';
const password = randomBytes(24).toString('base64url');
const database = new URL(process.env.DATABASE_URL_MIGRATE ?? '');
if (!['localhost', '127.0.0.1'].includes(database.hostname)) throw new Error('Evaluation requires local si_test');
database.pathname = '/si_test';
const pool = new Pool({ connectionString: database.toString() });
type Case = {id: string; sources: Source[]; turns: string[]};
type Item = {id: string; status: 'correct' | 'refused correctly' | 'wrong' | 'failed'; costUsd: number; latencyMs: number; turns: unknown[]};
const onlySet = process.argv.find(arg=>arg.startsWith('--set='))?.slice('--set='.length);
if (onlySet && onlySet !== 'heldout2') throw new Error('Only --set=heldout2 is supported');
// heldout2 has its own SQL-derived truth and is run once, after tuning (testbed/eval/heldout2-truth.ts).
const truth = {...await load('truth.json'), ...Object.fromEntries(Object.entries(await load('lineage-truth.json')).filter(([id]) => /^Q\d+$/.test(id))), ...(onlySet === 'heldout2' ? await load('heldout2-truth.json') : {})} as Record<string, Expected>;
const smoke = process.argv.includes('--smoke');
const selectedDevelopmentCases = process.argv.find(arg=>arg.startsWith('--questions='))?.slice('--questions='.length).split(',');
if (selectedDevelopmentCases?.some(id=>!/^Q[0-9]{2}$/.test(id))) throw new Error('Select development case IDs only');
const sets = onlySet === 'heldout2' ? [{name: 'heldout2', cases: await load('heldout2.json') as Case[], items: [] as Item[]}] : [
  {name: 'questions', cases: await load('questions.json') as Case[], items: [] as Item[]},
  ...(smoke || selectedDevelopmentCases ? [] : [{name: 'heldout', cases: await load('heldout.json') as Case[], items: [] as Item[]}]),
];
const catalog = {p: 'postgres', s: 'sql_server', x: 'excel'};
const ids = {} as Record<Source, string>;
let cookie = '';
let spend = 0;
async function request(path: string, method = 'GET', body?: Record<string, unknown> | Buffer) {
  const binary = Buffer.isBuffer(body);
  const response = await fetch(base + '/api' + path, {
    method, signal: AbortSignal.timeout(90_000),
    headers: {cookie, ...(body ? {'content-type': binary ? 'application/octet-stream' : 'application/json'} : {})},
    ...(body ? {body: binary ? new Uint8Array(body) : JSON.stringify(body)} : {}),
  });
  if (path === '/auth/login' && response.ok) cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  return {status: response.status, body: await response.json()};
}
async function checked(path: string, method: string, body?: Record<string, unknown> | Buffer) {
  const result = await request(path, method, body);
  if (result.status >= 300) throw new Error(path + ' HTTP ' + result.status + ' ' + result.body.error);
  return result.body;
}
async function cost() {
  return withTenant(pool, tenantId, async client => Number((await client.query(
    'SELECT coalesce(sum(cost_usd),0) AS total FROM core.model_usage WHERE tenant_id=$1', [tenantId])).rows[0].total));
}
async function connect() {
  const pg = new URL(process.env.DATABASE_URL_TESTBED ?? '');
  if (!['localhost', '127.0.0.1'].includes(pg.hostname) || pg.pathname !== '/si_testbed_pg') throw new Error('Expected local PostgreSQL testbed');
  const sql = process.env;
  if (!['localhost', '127.0.0.1'].includes(sql.SQLSERVER_TESTBED_HOST ?? '') ||
      sql.SQLSERVER_TESTBED_DATABASE !== 'si_testbed_sqlserver') throw new Error('Expected local SQL Server testbed');
  const sources = [
    ['p', 'PostgreSQL testbed', {host: pg.hostname, port: Number(pg.port || 5432), database: pg.pathname.slice(1),
      username: decodeURIComponent(pg.username), password: decodeURIComponent(pg.password), sslMode: 'disable'}],
    ['s', 'SQL Server testbed', {host: sql.SQLSERVER_TESTBED_HOST, port: Number(sql.SQLSERVER_TESTBED_PORT),
      database: sql.SQLSERVER_TESTBED_DATABASE, username: sql.SQLSERVER_TESTBED_USERNAME,
      password: sql.SQLSERVER_TESTBED_PASSWORD, trustServerCertificate: true}],
    ['x', 'Operations workbook', undefined],
  ] as const;
  for (const [source, displayName, credential] of sources) {
    const {connectionId} = await checked('/connections', 'POST', {connectorType: catalog[source], displayName, credential});
    ids[source] = connectionId;
    const path = '/connections/' + connectionId;
    if (source === 'x') await checked(path + '/workbooks', 'POST', await readFile('testbed/excel/hospital-operations.xlsx'));
    const tested = await checked(path + '/test', 'POST', {});
    if (!tested.ok) throw new Error('Source test failed for ' + source);
    await checked(path + '/activate', 'POST', {});
    await checked(path + '/discover', 'POST', {jobType: 'profile'});
  }
  // The testbed dbt project builds into the PostgreSQL testbed; its artifacts come from pnpm testbed:dbt.
  const dbt = await checked('/connections', 'POST', {connectorType: 'dbt', displayName: 'Hospital dbt project', warehouseConnectionId: ids.p});
  await checked('/connections/' + dbt.connectionId + '/dbt-artifacts', 'POST', {manifest: JSON.parse(await readFile('testbed/dbt/target/manifest.json', 'utf8')), catalog: JSON.parse(await readFile('testbed/dbt/target/catalog.json', 'utf8'))});
}
type Actual = {connectorType: string; sourceId?: string; value?: number | null; withheld?: true; categoryNotFound?: true; rows?: Array<{group_value: string; group_key?: string; value: number | string}>;
  lineage?: {direction: string; steps: Array<{from: string; to: string}>; gaps: Array<{asset: string; reason: string}>}};
function same(expected: Result, actual: Actual) {
  if (actual.categoryNotFound) return false;
  if (typeof expected === 'object' && !Array.isArray(expected)) {
    // Lineage: exactly the expected related objects, and any expected gap stated.
    if (!actual.lineage) return false;
    const related = [...new Set(actual.lineage.steps.map(step => actual.lineage!.direction === 'upstream' ? step.from : step.to))].sort();
    return JSON.stringify(related) === JSON.stringify([...expected.lineage].sort()) && (!expected.gapIncludes || actual.lineage.gaps.some(gap => gap.reason.includes(expected.gapIncludes!)));
  }
  if (actual.withheld && typeof expected === 'number') return expected > 0 && expected < 11 && actual.value == null && !actual.rows?.length;
  if (typeof expected === 'number') return actual.value != null && Number(actual.value) === expected && !actual.rows?.length;
  const rows = actual.rows;
  return rows?.length === expected.length && expected.every(group => rows.some(row =>
    // A key shown by its related label lists both (decision 45); the expected group may name either one.
    (String(row.group_value) === group.label || (row.group_key != null && String(row.group_key) === group.label)) && (row.value === '<11' ? group.value > 0 && group.value < 11 : Number(row.value) === group.value)));
}
async function evaluate(test: Case): Promise<Item> {
  const start = performance.now();
  const before = spend;
  const turns: unknown[] = [];
  let status: Item['status'] = 'failed';
  let conversationId: string | undefined;
  for (const question of test.turns) {
    try {
      if (spend >= 1.5) {
        turns.push({reason: 'local_cost_ceiling'});
        break;
      }
      const submitted = await request('/runs', 'POST', {question, sourceIds: test.sources.map(source => ids[source]), conversationId});
      if (submitted.status !== 201) {
        const code = submitted.body.error;
        if (code === 'analytic_query_unsupported' || code === 'analytic_source_choice_required') {
          if (truth[test.id] === null && code === 'analytic_query_unsupported') status = 'refused correctly';
        }
        turns.push({httpStatus: submitted.status, reason: code, ...(submitted.status >= 500 ? {message: submitted.body.message} : {})});
        break;
      }
      const {runId} = submitted.body;
      conversationId = submitted.body.conversationId;
      const path = '/runs/' + runId;
      const deadline = Date.now() + 90_000;
      let run = await checked(path, 'GET');
      while (!['COMPLETED','FAILED','CANCELLED','POLICY_BLOCKED','PARTIAL','EXPIRED'].includes(run.state) && Date.now() < deadline) {
        await delay(600);
        run = await checked(path, 'GET');
      }
      const answer = run.answer?.answer;
      const evidence = answer?.evidence ?? [];
      const events = run.state === 'COMPLETED' ? undefined : (await checked(path + '/events', 'GET')).events;
      const actual: Actual[] = answer?.bySource ?? [];
      const claims: string[] = (answer?.claims ?? []).map((claim: {statement: string}) => claim.statement);
      const sql = evidence.length ? evidence.map((item: {locator: string}) => item.locator) : await readExecutedSql(pool, tenantId, runId);
      turns.push({runId, state: run.state, actual, claims, sql,
        modelCalls: run.modelProvenance?.map(({purpose, model, inputTokens, outputTokens, typedPlan}: {
          purpose: string; model: string; inputTokens: number; outputTokens: number; typedPlan?: {intents?: unknown};
        }) => ({purpose, model, inputTokens, outputTokens, intents: typedPlan?.intents})), events});
      if (run.state !== 'COMPLETED') {
        const terminalReason = events?.at(-1)?.safe_payload?.reason;
        if (['analytic_query_unsupported', 'analytic_sensitive_column'].includes(terminalReason) && truth[test.id] === null) status = 'refused correctly';
        break;
      }
      if (turns.length < test.turns.length) continue;
      const expected = truth[test.id];
      // A query answer carries one evidence item per source; a lineage answer one per recorded link, each tied to an answered source.
      const evidenced = actual.some(item => item.lineage)
        ? actual.every(item => evidence.some((ref: {source_id: string}) => ref.source_id === item.sourceId)) && evidence.every((ref: {source_id: string}) => actual.some(item => item.sourceId === ref.source_id))
        : evidence.length === actual.length;
      status = expected && claims.length && evidenced && actual.length === Object.keys(expected).length &&
        (Object.entries(expected) as [Source, Result][]).every(([source, value]) =>
          actual.some(item => item.connectorType === catalog[source] && same(value, item))) ? 'correct' : 'wrong';
    } catch (error) {
      turns.push({reason: error instanceof Error ? error.message : 'request_failed'});
      break;
    } finally {
      spend = await cost();
    }
  }
  return {id: test.id, status, costUsd: Number((spend - before).toFixed(8)), latencyMs: Math.round(performance.now() - start), turns};
}
function summary(items: Item[]) {
  const counts = Object.fromEntries(['correct', 'refused correctly', 'wrong', 'failed'].map(status => [status, items.filter(item => item.status === status).length]));
  const average = (sum:number) => items.length ? sum / items.length : 0;
  return {...counts,total:items.length,
    averageLatencyMs:Math.round(average(items.reduce((total,item)=>total+item.latencyMs,0))),
    averageCostUsd:Number(average(items.reduce((total,item)=>total+item.costUsd,0)).toFixed(8)),
    score: counts.correct! + counts['refused correctly']! - counts.failed! - 2 * counts.wrong!};
}
async function save() {
  await writeFile(output, JSON.stringify({started: started.toISOString(), tenantId, costUsd: spend, sets: sets.map(set => ({
    name: set.name, summary: summary(set.items), results: set.items,
  }))}, null, 2) + '\n', {mode: 0o600});
}

try {
  await checked('/health', 'GET');
  await createTenant(pool, {tenantId, name: 'Planner evaluation', displayName: 'Evaluator', email, password});
  await checked('/auth/login', 'POST', {tenantId, email, password});
  await connect();
  for (const set of sets) {
    const cases = smoke ? set.cases.slice(0,1) : selectedDevelopmentCases
      ? set.cases.filter(test=>selectedDevelopmentCases.includes(test.id)) : set.cases;
    for (const test of cases) {
      const item = await evaluate(test);
      set.items.push(item);
      if (set.name === 'questions') console.log(set.name, item.id, item.status, item.latencyMs + 'ms', '$' + item.costUsd);
      await save();
    }
    console.log(set.name, summary(set.items));
  }
  console.log('Total USD', spend, output.pathname);
} finally {
  await pool.end();
}

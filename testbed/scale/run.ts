import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { chromium } from '@playwright/test';
import { withTenant } from '@scaleinsyght/db';
import { createTenant } from '../../scripts/tenant-create.js';
import { readExecutedSql } from '../../scripts/eval-planner-sql.js';

// Scale test against the 5,000-table catalog (testbed/scale/generate.ts): profiling time through the product, load
// time of the ER, Dictionary and Lineage endpoints and pages, and planner accuracy on testbed/scale/questions.json.
// Needs the testbed API, worker and parser running (API on TESTBED_API_PORT) and the web app on TESTBED_WEB_PORT.
// Writes testbed/scale/results/<time>.json. Local only; makes about 10 to 30 planner calls.
config({ path: resolve('.env') });
if (process.env.CI) throw new Error('The scale test is local only');
const api = `http://127.0.0.1:${process.env.TESTBED_API_PORT ?? '3340'}`;
const web = `http://127.0.0.1:${process.env.TESTBED_WEB_PORT ?? '4290'}`;
const scale = new URL(process.env.DATABASE_URL_SCALE ?? ''); if (!scale.hostname) throw new Error('DATABASE_URL_SCALE is required; run pnpm exec tsx testbed/scale/generate.ts');
const migrateUrl = new URL(process.env.DATABASE_URL_MIGRATE ?? ''); migrateUrl.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`;
const pool = new Pool({ connectionString: migrateUrl.toString() });
const skipPlanner = process.argv.includes('--no-planner');
type Question = { id: string; question: string; table: string; sql: string };
type Expected = number | Array<{ label: string; value: number }>;
const questions = JSON.parse(readFileSync('testbed/scale/questions.json', 'utf8')) as Question[];
const truth = JSON.parse(readFileSync('testbed/scale/truth.json', 'utf8')) as Record<string, Expected>;

let cookie = '';
/** HTTP without client timeouts: activation profiles the whole catalog inside one request. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- API responses are read as untyped JSON in this local script
type Json = any;
function call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: Json; ms: number }> {
  const started = performance.now();
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(api + path, { method, headers: { cookie, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (path === '/api/auth/login') cookie = String(res.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
        let parsed: Json = text; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        done({ status: res.statusCode ?? 0, body: parsed, ms: Math.round(performance.now() - started) });
      });
    });
    req.on('error', fail); if (payload) req.write(payload); req.end();
  });
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

const tenantId = `scale-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = randomBytes(18).toString('base64url');
await createTenant(pool, { tenantId, name: 'Scale workspace', displayName: 'Scale Analyst', email, password });
if ((await call('/api/auth/login', 'POST', { tenantId, email, password })).status !== 200) throw new Error('login failed');
const result: Record<string, unknown> = { started: new Date().toISOString(), tenantId };

// 1. Connect and profile through the product.
const draft = await call('/api/connections', 'POST', { connectorType: 'postgres', displayName: 'Scale warehouse', credential: { host: scale.hostname, port: Number(scale.port || 5432), database: scale.pathname.slice(1), username: decodeURIComponent(scale.username), password: decodeURIComponent(scale.password), sslMode: 'disable' } });
const connectionId = draft.body.connectionId as string;
const tested = await call(`/api/connections/${connectionId}/test`, 'POST', {});
const activated = await call(`/api/connections/${connectionId}/activate`, 'POST', { scope: [] });
if (activated.status !== 200) throw new Error(`activation failed: HTTP ${activated.status} ${JSON.stringify(activated.body).slice(0, 300)}`);
const graph = await withTenant(pool, tenantId, async (db) => (await db.query<{ datasets: string; fields: string; references: string }>(
  `SELECT (SELECT count(*) FROM graph.assets WHERE tenant_id=$1 AND asset_type='dataset' AND active)::text AS datasets,
          (SELECT count(*) FROM graph.assets WHERE tenant_id=$1 AND asset_type='field' AND active)::text AS fields,
          (SELECT count(*) FROM graph.relationships WHERE tenant_id=$1 AND relationship_type='REFERENCES')::text AS references`, [tenantId])).rows[0]!);
result.profiling = { connectionTestMs: tested.ms, activateAndProfileMs: activated.ms, profile: activated.body.profile, graph };
process.stdout.write(`profiled in ${(activated.ms / 1000).toFixed(1)} s: ${JSON.stringify(activated.body.profile)} ${JSON.stringify(graph)}\n`);

// 2. Endpoint times (three calls each, median) and response sizes.
const endpoints: Record<string, string> = { er: `/api/connections/${connectionId}/er`, dictionary: `/api/connections/${connectionId}/dictionary`, lineage: '/api/lineage/graph' };
const endpointTimes: Record<string, { medianMs: number; bytes: number; status: number }> = {};
for (const [name, path] of Object.entries(endpoints)) {
  const runs = []; for (let index = 0; index < 3; index++) runs.push(await call(path));
  endpointTimes[name] = { medianMs: median(runs.map((run) => run.ms)), bytes: Buffer.byteLength(JSON.stringify(runs[0]!.body)), status: runs[0]!.status };
}
result.endpoints = endpointTimes;
process.stdout.write(`endpoints: ${JSON.stringify(endpointTimes)}\n`);

// 3. Page load in a browser: from navigation until the page's data request has returned and the network is idle.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${web}/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password);
await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL((url) => !url.pathname.startsWith('/login'));
const pages: Record<string, { ms: number; error: string | null }> = {};
mkdirSync('testbed/scale/results', { recursive: true });
for (const [name, path, endpoint] of [['er', `/er?connection=${connectionId}`, '/er'], ['dictionary', `/dictionary?connection=${connectionId}`, '/dictionary'], ['lineage', '/lineage', '/api/lineage/graph']] as const) {
  const started = performance.now();
  const response = page.waitForResponse((res) => res.url().includes(endpoint) && res.request().method() === 'GET', { timeout: 300_000 });
  await page.goto(web + path);
  await response; await page.waitForLoadState('networkidle', { timeout: 300_000 });
  const alert = await page.getByRole('alert').first().textContent({ timeout: 500 }).catch(() => null);
  pages[name] = { ms: Math.round(performance.now() - started), error: alert };
  await page.screenshot({ path: `testbed/scale/results/${name}.png` });
}
await browser.close();
result.pages = pages;
process.stdout.write(`pages: ${JSON.stringify(pages)}\n`);

// 4. What the planner would have been sent without narrowing (estimated, not sent): every table and column.
const catalog = await withTenant(pool, tenantId, async (db) => (await db.query<{ tables: string; columns: string; chars: string }>(
  `SELECT count(DISTINCT d.asset_id)::text AS tables,count(f.asset_id)::text AS columns,sum(length(d.qualified_name)+length(f.qualified_name)+40)::text AS chars
   FROM graph.assets d JOIN graph.relationships r ON r.tenant_id=d.tenant_id AND r.from_asset_id=d.asset_id AND r.relationship_type='CONTAINS'
   JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.to_asset_id WHERE d.tenant_id=$1 AND d.asset_type='dataset' AND d.active`, [tenantId])).rows[0]!);
result.unnarrowedCatalog = { tables: Number(catalog.tables), columns: Number(catalog.columns), approximateTokens: Math.round(Number(catalog.chars) / 4) };

// 5. Planner accuracy: correct only when the numbers match and the executed SQL reads the expected table.
function same(expected: Expected, actual: { value?: number | null; withheld?: true; rows?: Array<{ group_value: string; group_key?: string; value: number | string }> }) {
  if (actual.withheld && typeof expected === 'number') return expected > 0 && expected < 11 && actual.value == null && !actual.rows?.length;
  if (typeof expected === 'number') return actual.value != null && Number(actual.value) === expected && !actual.rows?.length;
  const rows = actual.rows;
  return rows?.length === expected.length && expected.every((group) => rows.some((row) => (String(row.group_value) === group.label || (row.group_key != null && String(row.group_key) === group.label))
    && (row.value === '<11' ? group.value > 0 && group.value < 11 : Number(row.value) === group.value)));
}
const answers: Array<Record<string, unknown>> = [];
if (!skipPlanner) for (const item of questions) {
  const started = performance.now();
  const submitted = await call('/api/runs', 'POST', { question: item.question, sourceIds: [connectionId] });
  let status = 'failed'; let detail: unknown = submitted.body?.error ?? null; let sql: string[] = [];
  if (submitted.status === 201) {
    const runId = submitted.body.runId as string; let run: Json = null;
    for (const deadline = Date.now() + 180_000; Date.now() < deadline;) {
      run = (await call(`/api/runs/${runId}`)).body;
      if (['COMPLETED', 'PARTIAL', 'FAILED', 'POLICY_BLOCKED', 'CANCELLED'].includes(run?.state)) break;
      await new Promise((done) => setTimeout(done, 1000));
    }
    sql = await readExecutedSql(pool, tenantId, runId);
    const actual = run?.answer?.answer?.bySource?.[0];
    const readsTable = sql.some((text) => new RegExp(`\\b${item.table.replace('.', '\\.')}\\b`, 'i').test(text.replace(/"/g, '')));
    status = run?.state === 'COMPLETED' && actual && same(truth[item.id]!, actual) ? (readsTable ? 'correct' : 'wrong table, right number') : run?.state === 'COMPLETED' ? 'wrong' : 'failed';
    detail = run?.state === 'COMPLETED' ? null : run?.state;
  }
  const usage = await withTenant(pool, tenantId, async (db) => (await db.query<{ input: string; cost: string }>('SELECT coalesce(sum(input_tokens),0)::text AS input,coalesce(sum(cost_usd),0)::text AS cost FROM core.model_usage WHERE tenant_id=$1', [tenantId])).rows[0]!);
  answers.push({ id: item.id, status, detail, latencyMs: Math.round(performance.now() - started), sql: sql.map((text) => text.slice(0, 400)), cumulativeInputTokens: Number(usage.input), cumulativeCostUsd: Number(usage.cost) });
  process.stdout.write(`${item.id} ${status} ${Math.round(performance.now() - started)}ms\n`);
}
result.planner = { answers, correct: answers.filter((answer) => answer.status === 'correct').length, total: answers.length };
const file = `testbed/scale/results/${new Date().toISOString().replaceAll(':', '-')}.json`;
writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`written ${file}\n`);
await pool.end();

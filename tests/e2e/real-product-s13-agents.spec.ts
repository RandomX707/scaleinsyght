import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import 'dotenv/config';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { createTenant } from '../../scripts/tenant-create.js';
import { activateAndWait } from '../support/e2e-profile.js';

// S13: the Agents screen on real connectors (CLAUDE.md 10.2, prototype V.agents). Every agent shown comes from the
// registry: a connector agent per active connection, one collating agent per source group (decision 20: one group per
// source until a person adjusts them), the ID agent's counts from the graph, and the governed agents table.
const platformUrl = new URL(process.env.DATABASE_URL_MIGRATE ?? '');
platformUrl.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`;
const pool = new Pool({ connectionString: platformUrl.toString() });
const postgres = new URL(process.env.DATABASE_URL_TESTBED ?? '');
if (!postgres.hostname || !process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('The PostgreSQL and SQL Server testbeds are required; run pnpm testbed:up (it includes pnpm testbed:dictionary).');
const screen = (name: string) => `docs/acceptance/s13/${name}.png`;

async function connect(page: Page, data: Record<string, unknown>): Promise<string> {
  const draft = await page.request.post('/api/connections', { data }); expect(draft.status()).toBe(201);
  const { connectionId } = await draft.json() as { connectionId: string };
  expect((await page.request.post(`/api/connections/${connectionId}/test`)).ok()).toBeTruthy();
  await activateAndWait(page, connectionId);
  return connectionId;
}
const tiers = (page: Page) => page.getByRole('article', { name: 'How the agents are arranged' });
const group = (page: Page, members: string) => tiers(page).getByRole('region', { name: `Collating agent for ${members}` });

test.afterAll(async () => { await pool.end(); });

test('s13_agents_screen_shows_the_registry_and_adjusting_groups_makes_a_new_group_version', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const tenantId = `agents-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 'agents-walkthrough-password-2026';
  await createTenant(pool, { tenantId, name: 'Agents workspace', displayName: 'Test Analyst', email, password });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Test Analyst$/ })).toBeVisible();

  // Before any connector: the fixed tiers, no connector agents and no governed agents.
  await page.getByRole('link', { name: /Agents/ }).click();
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await expect(tiers(page)).toContainText('Your agent');
  await expect(tiers(page)).toContainText('Orchestrator agent');
  await expect(tiers(page)).toContainText('No connector agents yet.');
  await expect(page.getByText('No governed agents yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adjust groups' })).toHaveCount(0);

  const pg = await connect(page, { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: postgres.hostname, port: Number(postgres.port || 5432), database: postgres.pathname.slice(1), username: decodeURIComponent(postgres.username), password: decodeURIComponent(postgres.password), sslMode: 'disable' } });
  const sql = await connect(page, { connectorType: 'sql_server', displayName: 'SQL Server dictionary testbed', credential: { host: process.env.SQLSERVER_TESTBED_HOST, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: 'si_testbed_dictionary', username: process.env.SQLSERVER_TESTBED_USERNAME, password: process.env.SQLSERVER_TESTBED_PASSWORD, trustServerCertificate: true } });

  // One collating agent per source (decision 20), each holding that connection's connector agent.
  const registry = await withTenant(pool, tenantId, async (db) => ({
    agents: (await db.query<{ connection_id: string; agent_type: string; status: string }>(`SELECT c.connection_id,a.agent_type,a.status FROM registry.connections c JOIN registry.agents a ON a.tenant_id=c.tenant_id AND a.agent_id=c.connector_agent_id WHERE c.tenant_id=$1`, [tenantId])).rows,
    ids: (await db.query<{ fields: number; matches: number; paths: number }>(`SELECT (SELECT count(*) FROM graph.id_fields WHERE tenant_id=$1 AND active)::int AS fields,
        (SELECT count(*) FROM graph.relationships WHERE tenant_id=$1 AND relationship_type='SAME_AS')::int AS matches,
        (SELECT count(DISTINCT path_id) FROM graph.id_path_steps WHERE tenant_id=$1)::int AS paths`, [tenantId])).rows[0]!,
  }));
  expect(registry.agents.map((agent) => agent.status)).toEqual(['active', 'active']);
  await page.reload();
  await expect(group(page, 'PostgreSQL testbed')).toContainText('PostgreSQL agent');
  await expect(group(page, 'SQL Server dictionary testbed')).toContainText('SQL Server agent');
  for (const members of ['PostgreSQL testbed', 'SQL Server dictionary testbed']) await expect(group(page, members)).toContainText('Proposed by profiler');
  // The ID agent's counts are read from the graph, not illustrative.
  const plural = (count: number, one: string, many: string) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
  await expect(tiers(page)).toContainText(`${plural(registry.ids.fields, 'ID field', 'ID fields')} · ${plural(registry.ids.matches, 'match', 'matches')} across sources`);
  await expect(tiers(page)).toContainText(`Sub-agent · ${plural(registry.ids.paths, 'ID path', 'ID paths')}`);
  await page.screenshot({ path: screen('agents') });

  // Adjust groups: move the SQL Server agent into the PostgreSQL group. That is a new version of the group; plans pin versions.
  const before = await withTenant(pool, tenantId, (db) => db.query<{ source_group_id: string; version: number }>(
    `SELECT g.source_group_id,g.version FROM registry.source_groups g JOIN registry.source_group_members m ON m.tenant_id=g.tenant_id AND m.source_group_id=g.source_group_id AND m.group_version=g.version AND m.valid_to IS NULL WHERE g.tenant_id=$1 AND m.connection_id=$2`, [tenantId, pg]));
  await page.getByRole('button', { name: 'Adjust groups' }).click();
  await page.getByLabel('Move SQL Server dictionary testbed to').selectOption({ label: 'PostgreSQL testbed' });
  await expect(page.getByRole('status')).toHaveText('Group updated. New plans use the new group version.');
  await expect(group(page, 'PostgreSQL testbed and SQL Server dictionary testbed')).toContainText('SQL Server agent');
  await expect(tiers(page).getByRole('region')).toHaveCount(1);
  const after = await withTenant(pool, tenantId, (db) => db.query<{ connection_id: string; source_group_id: string; version: number }>(
    `SELECT m.connection_id,g.source_group_id,g.version FROM registry.source_groups g JOIN registry.source_group_members m ON m.tenant_id=g.tenant_id AND m.source_group_id=g.source_group_id AND m.group_version=g.version AND m.valid_to IS NULL WHERE g.tenant_id=$1 ORDER BY m.connection_id`, [tenantId]));
  expect(new Set(after.rows.map((row) => row.source_group_id))).toEqual(new Set([before.rows[0]!.source_group_id]));
  expect(after.rows.map((row) => row.connection_id).sort()).toEqual([pg, sql].sort());
  expect(after.rows[0]!.version).toBeGreaterThan(before.rows[0]!.version);
  await page.screenshot({ path: screen('agents-adjusted') });

  // The prototype's Agents screen, captured for the UI report pair.
  const prototype = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await prototype.goto(pathToFileURL(resolve('docs/prototype/index.html')).href);
    await prototype.getByRole('button', { name: 'Sign in', exact: true }).click();
    await prototype.evaluate('go("agents")');
    await expect(prototype.getByRole('heading', { name: 'Governed agents' })).toBeVisible();
    mkdirSync('docs/acceptance/s13/prototype', { recursive: true });
    await prototype.screenshot({ path: 'docs/acceptance/s13/prototype/agents.png' });
  } finally { await prototype.close(); }
});

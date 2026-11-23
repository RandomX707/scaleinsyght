import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:5174';
const prototypeUrl = pathToFileURL(resolve(root, 'docs/prototype/index.html')).href;
const output = resolve(root, 'docs/ui/screens');
let connection = process.env.DEMO_CONNECTION_ID ?? '';
const screens: Array<{ slug: string; route: string; prototype: string; addFlow?: boolean }> = [
  { slug: 'home', route: '/', prototype: 'home' },
  { slug: 'connectors', route: '/connectors', prototype: 'connectors' },
  { slug: 'connector-add-flow', route: '/connectors', prototype: 'connectors', addFlow: true },
  { slug: 'profile', route: `/profile/${connection}`, prototype: 'discovery' },
  { slug: 'er-explorer', route: `/er?connection=${connection}`, prototype: 'explorer' },
  { slug: 'dictionary', route: `/dictionary?connection=${connection}`, prototype: 'dictionary' },
  { slug: 'lineage-table', route: '/lineage', prototype: 'lineage' },
  { slug: 'lineage-column', route: '/lineage/columns', prototype: 'lineage' },
  { slug: 'id-trace', route: '/lineage/ids', prototype: 'lineage', addFlow: false },
  { slug: 'bi-reports', route: '/bi-reports', prototype: 'lineage' },
  { slug: 'reports', route: '/reports', prototype: 'reports' },
  { slug: 'agents', route: '/agents', prototype: 'agents' },
  { slug: 'my-agent', route: '/my-agent', prototype: 'my-agent' },
  { slug: 'hub-integrations', route: '/hub', prototype: 'agents' },
  { slug: 'approval-matrix', route: '/approval-matrix', prototype: 'review' },
  { slug: 'controls', route: `/controls?connection=${connection}`, prototype: 'controls' },
  { slug: 'usage', route: '/usage', prototype: 'usage' },
];

execFileSync('pnpm', ['demo:seed'], { cwd: root, stdio: 'inherit' });
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const app = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const prototype = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

try {
  await app.goto(`${appUrl}/login`);
  if (await app.getByLabel('Email').count()) {
    await app.getByLabel('Email').fill(process.env.DEMO_EMAIL ?? 'analyst@north.example');
    await app.getByLabel('Password').fill('golden-local-only');
    await app.getByRole('button', { name: 'Sign in', exact: true }).click();
    await app.getByRole('button', { name: /New chat/ }).waitFor();
  }
    if (!connection) connection = await app.evaluate(async () => {
    const data = await (await fetch('/api/connections')).json() as { connections: Array<{ connectionId: string; connectorType: string; status: string }> };
    const candidates = data.connections.filter(item => item.status === 'active' && ['postgres','sql_server','snowflake','excel'].includes(item.connectorType));
    let selected = '';
    let largestProfile = -1;
    for (const item of candidates) {
      const profile = await (await fetch(`/api/connections/${item.connectionId}/profile`)).json() as { profile: { listed_count?: number } | null };
      const listed = Number(profile.profile?.listed_count ?? -1);
      const graph = await (await fetch(`/api/connections/${item.connectionId}/er`)).json() as { relationships?: Array<{ from_name: string; to_name: string }> };
      const hospitalSchema = graph.relationships?.some(edge => /patient|encounter|order|department|provider/i.test(`${edge.from_name} ${edge.to_name}`)) ?? false;
      const score = listed + (item.connectorType === 'postgres' ? 1_000_000 : 0) + (hospitalSchema ? 10_000_000 : 0);
      if (profile.profile && score > largestProfile) { selected = item.connectionId; largestProfile = score; }
    }
    if (selected) return selected;
    throw new Error('No profiled demo connector is available for screen capture.');
  });
  for (const screen of screens) {
    const route = screen.route.startsWith('/profile/') ? `/profile/${connection}` : screen.route.replace('connection=', `connection=${connection}`);
    await app.goto(new URL(route, appUrl).href);
    if (screen.slug === 'profile') {
      await app.locator('.profile-ring').waitFor({ state: 'visible', timeout: 20000 });
    } else await app.waitForTimeout(350);
    if (screen.slug === 'home') {
      await app.locator('.source-picker summary').click();
      const sourceIds = await app.locator('[data-source-id]').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).dataset.sourceId).filter((value): value is string => Boolean(value)));
      for (const [index, sourceId] of sourceIds.entries()) {
        const checkbox = app.locator(`[data-source-id="${sourceId}"]`);
        if (index < 2 && !(await checkbox.isChecked())) await checkbox.check();
        if (index >= 2 && await checkbox.isChecked()) await checkbox.uncheck();
      }
      await app.locator('.source-picker summary').click();
      await app.getByLabel('Ask a question').fill('For Meridian Keystone, how many catalog objects are listed? Case 1.');
      const started = app.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
      await app.getByRole('button', { name: 'Send question' }).click();
      if (!(await started).ok()) throw new Error('The seeded Home question could not be started.');
      await app.getByText('Completed', { exact: true }).waitFor({ timeout: 20000 });
      await app.locator('.evidence-card').first().waitFor();
    }
    if (screen.addFlow) await app.getByRole('button', { name: 'Add connector' }).first().click();
    if (screen.slug === 'lineage-table' || screen.slug === 'lineage-column') {
      const target = await app.evaluate(async () => {
        const data = await (await fetch('/api/lineage/assets')).json() as { assets: Array<{ asset_id: string; qualified_name: string }> };
        const asset = data.assets.find(item => item.qualified_name === 'dbt.customer_mart');
        if (!asset) throw new Error('The seeded connected model is missing from the graph.');
        const lineage = await (await fetch(`/api/lineage?assetId=${encodeURIComponent(asset.asset_id)}`)).json() as { edges?: unknown[] };
        if (!lineage.edges?.length) throw new Error('The seeded connected model has no lineage edges.');
        return asset.asset_id;
      });
      const response = app.waitForResponse(item => item.url().includes(`/api/lineage?assetId=${target}`));
      await app.locator('select[aria-label="Graph asset"]').selectOption(target);
      if (!(await response).ok()) throw new Error('The seeded lineage request failed.');
      await app.locator(screen.slug === 'lineage-table' ? '.lineage-edges li' : '.lineage-layout table tbody tr').first().waitFor();
    }
    if (screen.slug === 'id-trace') {
      const options = await app.locator('select[aria-label="Identifier field"] option').evaluateAll(nodes => nodes.map(node => ({ value: (node as HTMLOptionElement).value, label: node.textContent ?? '' })));
      const target = options.find(option => /customer_id|customer_key/i.test(option.label));
      if (target) { const response = app.waitForResponse(item => item.url().includes('/api/lineage?assetId=')); await app.locator('select[aria-label="Identifier field"]').selectOption(target.value); await response; }
    }
    const visibleCopy = await app.locator('body').innerText();
    const copyViolations = [
      ['synthetic fixture copy', /\bsynthetic\b/i], ['fixture source URL', /golden:\/\//i],
      ['internal role name', /insyght_reader|\bsi_(?:app|worker|migrate)\b/i],
      ['internal UUID', /[0-9a-f]{8}-[0-9a-f-]{27,}/i],
      ['vendor product name', /\b(?:snowflake|tableau|power\s*bi|sql\s*server|postgres(?:ql)?|oracle|excel)\b/i],
    ].filter(([,pattern]) => (pattern as RegExp).test(visibleCopy)).map(([label]) => label);
    if (copyViolations.length) throw new Error(`UI copy check failed on ${screen.slug}: ${copyViolations.join(', ')}.`);
    const appShot = await app.screenshot({ animations: 'disabled' });

    await prototype.goto(prototypeUrl);
    await prototype.evaluate(() => (window as Window & { signIn: () => void }).signIn());
    await prototype.evaluate(route => (window as Window & { go: (value: string) => void }).go(route), screen.prototype);
    if (screen.slug === 'home') {
      await prototype.evaluate(() => (window as Window & { startAsk: (question: string) => void }).startAsk('For Meridian Keystone, how many catalog objects are listed? Case 1.'));
      await prototype.locator('.answer').waitFor({ timeout: 10000 });
    }
    if (screen.slug === 'connector-add-flow') await prototype.evaluate(() => (window as Window & { openConnect: () => void }).openConnect());
    if (screen.slug === 'id-trace') await prototype.evaluate(() => (window as Window & { linMode: (mode: string) => void }).linMode('ids'));
    await prototype.waitForTimeout(250);
    const prototypeShot = await prototype.screenshot({ animations: 'disabled' });
    const composite = await browser.newPage({ viewport: { width: 2880, height: 900 }, deviceScaleFactor: 1 });
    await composite.setContent(`<div style="display:flex;width:2880px;height:900px"><img alt="Application screen" width="1440" height="900" src="data:image/png;base64,${appShot.toString('base64')}"><img alt="Prototype screen" width="1440" height="900" src="data:image/png;base64,${prototypeShot.toString('base64')}"></div>`);
    const result = await composite.screenshot({ animations: 'disabled' });
    await writeFile(resolve(output, `${screen.slug}.png`), result);
    await composite.close();
  }
  process.stdout.write(`Saved ${screens.length} side-by-side screen comparisons in docs/ui/screens/.\n`);
} finally {
  await browser.close();
}

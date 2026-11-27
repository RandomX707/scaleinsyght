import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

// Builds the 2880x900 app-and-prototype pairs in docs/ui/screens (app on the left, prototype on the right) from
// captures already on disk: app captures from the walkthroughs, prototype captures of docs/prototype/index.html.
// A prototype image wider than 1440 px (an existing pair) contributes its right half.
type Pair = { out: string; app: string; prototype: string };
const pairs: Pair[] = [
  { out: 'my-agent', app: 'docs/acceptance/phase5/my-agent.png', prototype: 'docs/acceptance/phase5/prototype/my-agent.png' },

  { out: 'usage', app: 'docs/acceptance/phase5/usage.png', prototype: 'docs/acceptance/phase5/prototype/usage.png' },
  { out: 'login', app: 'docs/acceptance/phase0/login.png', prototype: 'docs/acceptance/phase0/prototype/login.png' },
  { out: 'dictionary-landing', app: 'docs/acceptance/s9/landing.png', prototype: 'docs/acceptance/s9/prototype/landing.png' },
  { out: 'dictionary-table', app: 'docs/acceptance/s9/table.png', prototype: 'docs/acceptance/s9/prototype/table.png' },
  { out: 'dictionary-procedure', app: 'docs/acceptance/s9/procedure.png', prototype: 'docs/acceptance/s9/prototype/proc.png' },
  { out: 'dictionary-procedure-sql', app: 'docs/acceptance/s9/procedure-sql.png', prototype: 'docs/acceptance/s9/prototype/proc-sql.png' },
  { out: 'dictionary-encrypted', app: 'docs/acceptance/s9/encrypted.png', prototype: 'docs/acceptance/s9/prototype/encrypted.png' },
  { out: 'dictionary-search', app: 'docs/acceptance/s9/search.png', prototype: 'docs/acceptance/s9/prototype/search.png' },
  // Item 5: the offline export (left) beside the app's Dictionary (right), not the prototype.
  { out: 'dictionary-export-vs-app', app: 'docs/acceptance/s9/export-viewer.png', prototype: 'docs/acceptance/s9/procedure.png' },
  { out: 'dictionary-export-notice', app: 'docs/acceptance/s9/export-notice.png', prototype: 'docs/acceptance/s9/prototype/landing.png' },
  { out: 'agents', app: 'docs/acceptance/s13/agents.png', prototype: 'docs/acceptance/s13/prototype/agents.png' },
  { out: 'dictionary-function-returns', app: 'docs/acceptance/s9/function-returns.png', prototype: 'docs/acceptance/s9/prototype/proc.png' },
  { out: 'dictionary-approve-all', app: 'docs/acceptance/s9/approve-all.png', prototype: 'docs/acceptance/s9/prototype/table.png' },
  { out: 'dictionary-excel', app: 'docs/acceptance/s9/excel.png', prototype: 'docs/acceptance/s9/prototype/table.png' },
  { out: 'dictionary-dbt', app: 'docs/acceptance/s9/dbt.png', prototype: 'docs/acceptance/s9/prototype/table.png' },
  { out: 'dictionary-tableau', app: 'docs/acceptance/s9/tableau.png', prototype: 'docs/acceptance/s9/prototype/proc-sql.png' },
  { out: 'controls', app: 'docs/acceptance/s10/controls.png', prototype: 'docs/acceptance/s10/prototype/controls.png' },
  { out: 'home-plan-live', app: 'docs/acceptance/s11/plan-live.png', prototype: 'docs/acceptance/s11/prototype/plan-live.png' },
  { out: 'home-sentence', app: 'docs/acceptance/s11/sentence.png', prototype: 'docs/acceptance/s11/prototype/answer.png' },
  { out: 'home-small-table', app: 'docs/acceptance/s11/small-table.png', prototype: 'docs/acceptance/s11/prototype/answer.png' },
  { out: 'home-chart', app: 'docs/acceptance/s11/chart.png', prototype: 'docs/acceptance/s11/prototype/answer.png' },
  { out: 'home-compact-table', app: 'docs/acceptance/s11/compact-table.png', prototype: 'docs/acceptance/s11/prototype/answer.png' },
  { out: 'home-follow-ups', app: 'docs/acceptance/s11/follow-ups.png', prototype: 'docs/acceptance/s11/prototype/answer.png' },
  { out: 'home-refusal', app: 'docs/acceptance/s11/refusal.png', prototype: 'docs/acceptance/s11/prototype/answer.png' },
  { out: 'dictionary-er-neighbourhood', app: 'docs/acceptance/s9/er.png', prototype: 'docs/ui/screens/er-explorer.png' },
];
const only = process.argv.slice(2);
const dataUrl = (path: string) => `data:image/png;base64,${readFileSync(resolve(path)).toString('base64')}`;
mkdirSync('docs/ui/screens', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2880, height: 900 } });
for (const pair of pairs.filter((item) => !only.length || only.includes(item.out))) {
  await page.setContent(`<body style="margin:0;display:flex;width:2880px;height:900px;overflow:hidden;background:#fff">
    <div style="width:1440px;height:900px;overflow:hidden"><img src="${dataUrl(pair.app)}" style="display:block;width:1440px"></div>
    <div style="width:1440px;height:900px;overflow:hidden;position:relative"><img id="p" src="${dataUrl(pair.prototype)}" style="display:block;position:absolute;top:0;right:0"></div></body>`);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  await page.screenshot({ path: `docs/ui/screens/${pair.out}.png`, clip: { x: 0, y: 0, width: 2880, height: 900 } });
  process.stdout.write(`docs/ui/screens/${pair.out}.png\n`);
}
await browser.close();

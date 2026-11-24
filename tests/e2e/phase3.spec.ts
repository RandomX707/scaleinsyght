import { expect, test } from '@playwright/test';
import { signInToTestWorkspace } from '../support/e2e-auth.js';

async function signIn(page: import('@playwright/test').Page,email:string){
  await signInToTestWorkspace(page,email);
}

async function selectAssetAndWaitForLineage(page:import('@playwright/test').Page,qualifiedName:string){
  const {assets}=await page.evaluate(async()=>{
    const response=await fetch('/api/lineage/assets');
    return await response.json() as {assets:Array<{asset_id:string;qualified_name:string}>};
  });
  const asset=assets.find(candidate=>candidate.qualified_name===qualifiedName);
  expect(asset,`missing synthetic asset ${qualifiedName}`).toBeDefined();
  const expectedAssetId=asset!.asset_id;
  const lineageResponse=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/lineage'&&url.searchParams.get('assetId')===expectedAssetId&&url.searchParams.get('direction')==='both';
  });
  await page.getByLabel('Graph asset').selectOption(expectedAssetId);
  const response=await lineageResponse;
  expect(response.ok()).toBe(true);
}

test('phase3_lineage_id_trace_impact_reports_and_snapshot_compare_are_keyboard_accessible', async ({ page }) => {
  await signIn(page,'phase3-lineage@synthetic.example');
  await page.getByRole('link', { name: /Lineage/ }).click();
  await expect(page.getByRole('heading', { name: 'Lineage workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Import synthetic Power BI reports' }).click();
  await expect(page.getByRole('status')).toContainText('Synthetic lineage imported');
  await page.getByRole('button', { name: 'Import synthetic dbt manifest' }).click();
  await expect(page.getByRole('status')).toContainText('Synthetic lineage imported');
  await selectAssetAndWaitForLineage(page,'dbt.customer_mart');
  await expect(page.locator('.lineage-edges')).toContainText('Power BI.Customer Health');
  const idTraceLink=page.getByRole('link', { name: 'ID trace' });
  await idTraceLink.focus();
  await expect(idTraceLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'ID trace' })).toBeVisible();
  await expect(page.getByLabel('Identifier field')).toBeVisible();
  await page.getByRole('link', { name: 'Snapshot compare' }).click();
  await expect(page.getByRole('heading', { name: 'Snapshot compare' })).toBeVisible();
  await expect(page.getByLabel('Earlier snapshot')).toBeVisible();
  await expect(page.getByLabel('Later snapshot')).toBeVisible();
  await page.getByRole('link', { name: 'BI reports', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'BI reports' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Power BI.Customer Health' })).toHaveAttribute('href', '/demo/power-bi/customer-health');
});

test('c6_accepted_inference_stays_unverified_in_api_and_lineage_ui',async({page})=>{
  await signIn(page,'phase3-review@synthetic.example');
  await page.getByRole('link',{name:/Lineage/}).click();
  await page.getByRole('button',{name:'Import synthetic dbt manifest'}).click();
  await expect(page.getByRole('status')).toContainText('Synthetic lineage imported');
  await page.getByRole('button',{name:'Import synthetic Power BI reports'}).click();
  await expect(page.getByRole('status')).toContainText('Synthetic lineage imported');
  await selectAssetAndWaitForLineage(page,'dbt.customer_mart');
  await expect(page.locator('.lineage-edges')).toContainText('Power BI.Customer Health');
  const accept=page.getByRole('button',{name:'Accept assertion'}).first();
  await expect(accept).toBeVisible();
  await accept.click();
  await expect(page.getByRole('status')).toContainText('Assertion accepted; its verification status is unchanged.');
  const reviewed=page.locator('.assertion-row').filter({hasText:'accepted'}).first();
  await expect(reviewed.getByText('Verification: unverified')).toBeVisible();
});

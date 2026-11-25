import { expect,test } from '@playwright/test';
import { signInToTestWorkspace, workspaceForTestEmail } from '../support/e2e-auth.js';

async function signIn(page:import('@playwright/test').Page,email:string){
 await signInToTestWorkspace(page,email);
}

test('phase0_golden_login_reaches_empty_home_and_tenant_usage',async({page})=>{
 await page.goto(`/login?tenant=${encodeURIComponent(workspaceForTestEmail('phase0-login@synthetic.example'))}`);
 await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
 await signInToTestWorkspace(page,'phase0-login@synthetic.example');
 await expect(page).toHaveURL('/');
 await expect(page.getByText('Analytic mode · read-only')).toBeVisible();
 await expect(page.getByRole('heading',{name:'Good afternoon'})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Connect a source to get started'})).toBeVisible();
 const workspace=page.getByRole('button',{name:/Workspace/});
 await expect(workspace).toHaveAttribute('aria-expanded','true');
 await workspace.click();await expect(workspace).toHaveAttribute('aria-expanded','false');
 await page.reload();
 await expect(page.getByRole('button',{name:/Workspace/})).toHaveAttribute('aria-expanded','false');
 await page.getByRole('button',{name:/Workspace/}).click();
 await page.getByRole('button',{name:'Account'}).click();
 await page.getByRole('menuitem',{name:'Usage'}).click();
 await expect(page.getByRole('heading',{name:'Usage',exact:true})).toBeVisible();
 await expect(page.getByText('Active users')).toBeVisible();
 // Daily model budget: USD caps per workspace and per person (decision 43).
 for(const label of ['Workspace spend today · daily cap','Your spend today · daily cap per person'])await expect(page.locator('.usage-model .usage-summary > div').filter({hasText:label}).locator('strong')).toHaveText(/^USD \d+\.\d{2} of \d+\.\d{2}$/);
 await expect(page.getByRole('menuitem',{name:'Sign out'})).toBeVisible();
});

test('phase1_connector_add_starts_with_empty_state_and_real_postgres_credentials',async({page})=>{
 await signIn(page,'phase1-profile@synthetic.example');
 await expect(page).toHaveURL('/');
 await page.getByRole('link',{name:/Connectors/}).click();
 await expect(page.getByText(/No sources connected/)).toBeVisible();
 await page.locator('.page-heading').getByRole('button',{name:/Add connector/}).click();
 await expect(page.getByRole('heading',{name:'Add a PostgreSQL source'})).toBeVisible();
 await expect(page.getByLabel('Host')).toBeVisible();
 await expect(page.getByLabel('Database')).toBeVisible();
 await expect(page.getByLabel('Test source')).toHaveCount(0);
});

test('empty_home_never_starts_an_answer_or_returns_fixture_data',async({page})=>{
 await signIn(page,'phase1-search@synthetic.example');
 await expect(page.getByRole('heading',{name:'Connect a source to get started'})).toBeVisible();
 let runRequests=0;
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/runs')runRequests+=1;});
 await expect(page.getByRole('button',{name:'Send question'})).toBeDisabled();
 expect(runRequests).toBe(0);
 await expect(page.locator('body')).not.toContainText(/golden:|Prototype · example data/i);
});

test('phase2_home_on_an_empty_tenant_prompts_for_a_real_source_instead_of_answers',async({page})=>{
 await signIn(page,'phase2-owner@synthetic.example');
 await expect(page.getByRole('heading',{name:'Good afternoon'})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Connect a source to get started'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Send question'})).toBeDisabled();
});

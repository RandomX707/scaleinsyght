import { expect,test } from '@playwright/test';
import { signInToTestWorkspace } from '../support/e2e-auth.js';

async function signIn(page:import('@playwright/test').Page,email:string){
 await signInToTestWorkspace(page,email);
}

test('phase0_golden_login_reaches_empty_home_and_tenant_usage',async({page})=>{
 await page.goto('/login');
 await expect(page.getByRole('heading',{name:'Welcome to Scale Insyght'})).toBeVisible();
 await signInToTestWorkspace(page,'phase0-login@synthetic.example');
 await expect(page).toHaveURL('/');
 await expect(page.getByText('Analytic mode · read-only')).toBeVisible();
 await expect(page.getByRole('heading',{name:'What would you like to understand?'})).toBeVisible();
 const workspace=page.getByRole('button',{name:/WORKSPACE/});
 await expect(workspace).toHaveAttribute('aria-expanded','true');
 await workspace.click();await expect(workspace).toHaveAttribute('aria-expanded','false');
 await page.reload();
 await expect(page.getByRole('button',{name:/WORKSPACE/})).toHaveAttribute('aria-expanded','false');
 await page.getByRole('button',{name:/WORKSPACE/}).click();
 await page.getByRole('button',{name:'User'}).click();
 await page.getByRole('menuitem',{name:'Usage'}).click();
 await expect(page.getByRole('heading',{name:'Usage'})).toBeVisible();
 await expect(page.getByText('Active users')).toBeVisible();
 await expect(page.getByRole('menuitem',{name:'Sign out'})).toBeVisible();
});

test('phase1_connector_add_starts_with_empty_state_and_real_postgres_credentials',async({page})=>{
 await signIn(page,'phase1-profile@synthetic.example');
 await expect(page).toHaveURL('/');
 await page.getByRole('link',{name:/Connectors/}).click();
 await expect(page.getByText(/No sources connected/)).toBeVisible();
 await page.getByRole('button',{name:'Add connector'}).click();
 await expect(page.getByRole('heading',{name:'Add a PostgreSQL source'})).toBeVisible();
 await expect(page.getByLabel('Host')).toBeVisible();
 await expect(page.getByLabel('Database')).toBeVisible();
 await expect(page.getByLabel('Test source')).toHaveCount(0);
});

test('phase1_keyboard_navigation_and_empty_catalogue_search_have_no_fixture_results',async({page})=>{
 await signIn(page,'phase1-search@synthetic.example');
 await page.getByRole('link',{name:/Home/}).click();
 const dictionary=page.getByRole('link',{name:/Dictionary/});
 await dictionary.focus();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{name:'Dictionary'})).toBeVisible();
 await page.goto('/');
 let modelEndpointRequests=0;
 page.on('request',request=>{if(request.url().includes('/api/model'))modelEndpointRequests+=1;});
 const response=page.waitForResponse(item=>item.url().includes('/api/catalogue/search'));
 await page.getByLabel('Catalog question').fill('Table_001');
 await page.getByRole('button',{name:'Search catalog'}).click();
 const result=await (await response).json() as {matches:string[];modelRequests:number};
 expect(result.matches).toEqual([]);
 expect(result.modelRequests).toBe(0);
 expect(modelEndpointRequests).toBe(0);
});

test('phase2_home_on_an_empty_tenant_prompts_for_a_real_source_instead_of_answers',async({page})=>{
 await signIn(page,'phase2-owner@synthetic.example');
 await expect(page.getByRole('heading',{name:'What would you like to understand?'})).toBeVisible();
 await expect(page.getByText('Add a connector to start an analytic run.')).toBeVisible();
 await expect(page.getByRole('button',{name:'Ask question'})).toBeDisabled();
});

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

test('phase0_collapsed_sidebar_shows_every_item_expands_by_keyboard_and_opens_the_profile_menu_beside_it',async({page})=>{
 await page.setViewportSize({width:1440,height:900});
 await signInToTestWorkspace(page,'phase0-login@synthetic.example');
 // A closed Platform group must still show its icons in the strip.
 const platform=page.getByRole('button',{name:/^Platform/});
 if(await platform.getAttribute('aria-expanded')==='true')await platform.click();
 await page.getByRole('button',{name:'Collapse sidebar'}).click();
 const expand=page.getByRole('button',{name:'Expand sidebar'});
 await expect(expand).toBeVisible();
 const nav=page.getByRole('navigation',{name:'Main navigation'});
 for(const label of ['Home','Connectors','Dictionary','Lineage','Agents','BI reports','Hub integrations','Approval matrix','Controls']){
  const link=nav.getByRole('link',{name:label,exact:true});
  await expect(link).toBeVisible();
  await link.hover();await expect(page.getByRole('tooltip')).toHaveText(label);
 }
 await expect(page.getByRole('button',{name:'New chat'})).toBeVisible();
 // Tooltips follow keyboard focus too.
 await nav.getByRole('link',{name:'Approval matrix'}).focus();await expect(page.getByRole('tooltip')).toHaveText('Approval matrix');
 await page.screenshot({path:'docs/acceptance/shell/collapsed-sidebar-tooltip.png'});
 // The profile menu opens fully beside the strip: every item is the topmost element at its own centre.
 await page.getByRole('button',{name:/^Account menu/}).click();
 const menu=page.getByRole('menu',{name:'Account'});
 const strip=(await page.locator('.sidebar').boundingBox())!;const box=(await menu.boundingBox())!;
 expect(box.x).toBeGreaterThanOrEqual(strip.x+strip.width);
 for(const item of await menu.getByRole('menuitem').all()){
  await expect(item).toBeInViewport({ratio:1});
  expect(await item.evaluate(element=>{const rect=element.getBoundingClientRect();return element.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2));})).toBe(true);
 }
 await expect(menu.getByRole('menuitem').first()).toBeFocused();
 await page.screenshot({path:'docs/acceptance/shell/collapsed-sidebar-profile-menu.png'});
 await page.keyboard.press('Escape');await expect(menu).toBeHidden();
 await expect(page.getByRole('button',{name:/^Account menu/})).toBeFocused();
 // The collapsed state is remembered, and the strip expands from the keyboard.
 await page.reload();
 await expect(page.getByRole('button',{name:'Expand sidebar'})).toBeVisible();
 await page.getByRole('button',{name:'Expand sidebar'}).focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('button',{name:'Collapse sidebar'})).toBeVisible();
 await expect(nav.getByText('Agents',{exact:true})).toBeHidden(); // Platform is still closed in the full sidebar, as the person left it
 await page.getByRole('button',{name:/^Platform/}).click();
 await page.reload();await expect(page.getByRole('button',{name:'Collapse sidebar'})).toBeVisible();
});

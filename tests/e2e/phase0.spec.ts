import { expect,test } from '@playwright/test';

async function signIn(page:import('@playwright/test').Page,email:string){
 await page.goto('/login');await page.getByLabel('Email').fill(email);await page.getByLabel('Password').fill('golden-local-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();
}

async function profileSqlServer(page:import('@playwright/test').Page){
 await page.getByRole('link',{name:/Connectors/}).click();await page.locator('.page-heading').getByRole('button',{name:/Add connector/}).click();await page.getByRole('button',{name:/Meridian Harbor/}).click();await page.getByRole('button',{name:'Continue'}).click();await page.getByRole('button',{name:'Start profiling'}).click();await expect(page.getByRole('heading',{name:'Discovery complete'})).toBeVisible();await page.getByRole('button',{name:'Close'}).click();
}

test('phase0_golden_login_reaches_empty_home_and_tenant_usage',async({page})=>{
 await page.goto('/login');
 await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
 await page.getByLabel('Email').fill('phase0-login@synthetic.example');
 await page.getByLabel('Password').fill('golden-local-only');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page).toHaveURL('/');
 await expect(page.getByText('Prototype · example data')).toBeVisible();
 await expect(page.getByRole('heading',{name:'Good afternoon, Yashaswi'})).toBeVisible();
 const platform=page.getByRole('button',{name:/Platform/});
 await expect(platform).toHaveAttribute('aria-expanded','true');
 await platform.click();await expect(platform).toHaveAttribute('aria-expanded','false');
 await page.reload();
 await expect(page.getByRole('button',{name:/Platform/})).toHaveAttribute('aria-expanded','false');
 await page.getByRole('button',{name:/Platform/}).click();
 await page.getByRole('button',{name:/Yashaswi/}).click();
 await page.getByRole('menuitem',{name:'Usage'}).click();
 await expect(page.getByRole('heading',{name:'Usage',exact:true})).toBeVisible();
 await expect(page.getByText('Active users')).toBeVisible();
 await expect(page.getByRole('menuitem',{name:'Sign out'})).toBeVisible();
});

test('phase1_golden_source_activation_profiles_dictionary_and_read_once_notification',async({page})=>{
 await signIn(page,'phase1-profile@synthetic.example');
 await expect(page).toHaveURL('/');
 await page.getByRole('link',{name:/Connectors/}).click();
 await page.locator('.page-heading').getByRole('button',{name:/Add connector/}).click();
 await page.getByRole('button',{name:/Meridian Harbor/}).click();
 await page.getByRole('button',{name:'Continue'}).click();
 await expect(page.getByRole('heading',{name:'Choose scope'})).toBeVisible();
 const activation=page.waitForResponse(response=>response.url().includes('/api/connections/')&&response.url().endsWith('/activate')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Start profiling'}).click();
 expect((await activation).status()).toBe(200);
 await expect(page.getByRole('heading',{name:'Discovery complete'})).toBeVisible({timeout:15000});
 await expect(page.getByRole('status').filter({hasText:'499 objects profiled from 500 listed'})).toContainText('499 objects profiled from 500 listed');
 await page.getByRole('button',{name:'Close'}).click();
 const profiledSource=page.getByRole('article').filter({hasText:'Meridian Harbor'});
 await profiledSource.getByRole('button',{name:'Profile',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Profile',exact:true})).toBeVisible();
 await expect(page.getByText('500',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Open Dictionary'}).click();
 await expect(page.getByRole('heading',{name:'Dictionary'})).toBeVisible();
 await expect(page.getByText('Meridian Harbor · Table 001').first()).toBeVisible();
 await page.getByRole('button',{name:/Notifications/}).click();
 await expect(page.getByRole('heading',{name:'Notifications'})).toBeVisible();
 const newNotifications=page.locator('.notification-panel .notification-item');
 const newCount=await newNotifications.count();
 expect(newCount).toBeGreaterThan(0);
 const earlier=page.locator('.notification-panel h3').filter({hasText:'Earlier'}).locator('xpath=following-sibling::p');
 const earlierCount=await earlier.count();
 await newNotifications.first().click();
 await expect(newNotifications).toHaveCount(newCount-1);
 await expect(earlier).toHaveCount(earlierCount+1);
});

test('phase1_keyboard_navigation_and_catalogue_search_use_stored_metadata_only',async({page})=>{
 await signIn(page,'phase1-search@synthetic.example');
 await profileSqlServer(page);
 await page.getByRole('link',{name:/Home/}).click();
 const dictionary=page.getByRole('link',{name:/Dictionary/});
 await dictionary.focus();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{name:'Dictionary'})).toBeVisible();
 await page.goto('/');
 let modelEndpointRequests=0;
 page.on('request',request=>{if(request.url().includes('/api/model'))modelEndpointRequests+=1;});
 const response=page.waitForResponse(item=>item.url().includes('/api/catalogue/search'));
 await page.getByLabel('Ask a question').fill('Table_001');
 await page.getByRole('button',{name:'Send question'}).click();
 const result=await (await response).json() as {matches:string[];modelRequests:number};
 expect(result.matches).toContain('X_Golden.Table_001');
 expect(result.modelRequests).toBe(0);
 await expect(page.getByRole('heading',{name:'Catalog results'})).toBeVisible();
 await expect(page.getByText('Meridian Harbor · Table 001',{exact:true})).toBeVisible();
 expect(modelEndpointRequests).toBe(0);
});

test('phase2_home_persists_analytic_run_and_renders_evidence_and_feedback',async({page})=>{
 await page.setViewportSize({width:1440,height:900});await signIn(page,'phase2-owner@synthetic.example');
 await profileSqlServer(page);
 await profileSqlServer(page);
 await page.getByRole('link',{name:/Home/}).click();
 const sourceIds=await page.evaluate(async()=>{const result=await fetch('/api/analytic/sources').then(response=>response.json()) as {sources:Array<{id:string}>};return result.sources.map(source=>source.id);});
 expect(sourceIds.length).toBeGreaterThanOrEqual(2);
 await page.locator('.source-picker summary').click();
 for(const [index,sourceId] of sourceIds.entries()){const checkbox=page.locator(`[data-source-id="${sourceId}"]`);if(index<2)await checkbox.check();else await checkbox.uncheck();}
 await page.getByLabel('Ask a question').fill('For Meridian Keystone, how many catalog objects are listed? Case 1.');await page.getByRole('button',{name:'Send question'}).click();
 await expect(page.getByText('Completed',{exact:true})).toBeVisible({timeout:15000});await expect(page.locator('.chat-scroll')).toHaveCSS('overflow-y','auto');await page.locator('.chat-scroll').evaluate(element=>{element.scrollTop=element.scrollHeight;});await expect(page.getByRole('button',{name:'Useful',exact:true})).toBeInViewport();await expect(page.locator('.composer')).toBeInViewport();await expect(page.locator('.plan-card')).not.toContainText('Connected source');await expect(page.getByRole('button',{name:'Useful',exact:true})).toBeInViewport();await expect(page.getByRole('button',{name:'Not useful',exact:true})).toBeInViewport();await expect(page.getByText(/Source result: 500/)).toHaveCount(2);await expect(page.getByText('Evidence',{exact:true})).toBeVisible();await expect(page.getByText('Evidence-backed · read-only')).toBeVisible();await expect(page.getByRole('heading',{name:'Good afternoon, Yashaswi'})).toBeVisible();await expect(page.locator('body')).not.toContainText(/SQL Server|Power BI|Snowflake|Tableau|synthetic|golden:\/\/|run created|step claimed|\bsi_(?:app|worker|migrate)\b|[0-9a-f]{8}-[0-9a-f-]{27,}/i);await page.reload();await expect(page.getByText('Completed',{exact:true})).toBeVisible();await expect(page.getByText('Evidence',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Useful',exact:true}).click();await expect(page.getByRole('status')).toContainText('Feedback saved');
 await page.getByRole('button',{name:/Yashaswi/}).click();await page.getByRole('menuitem',{name:'My agent'}).click();await expect(page.getByRole('heading',{name:'My agent'})).toBeVisible();await page.getByLabel('Answer style').selectOption('detailed');await page.getByRole('button',{name:'Save preferences'}).click();await expect(page.getByRole('status')).toContainText('Your preferences were saved');
 await page.getByRole('link',{name:/Agents/}).click();await page.getByLabel('Name').fill('Golden governed listing');await page.getByLabel('Question').fill('For Meridian Keystone, how many catalog objects are listed? Case 1.');await page.getByRole('button',{name:'Save draft version'}).click();await expect(page.getByRole('status')).toContainText('Draft version 1 saved');
 const profileMenu=page.getByRole('button',{name:/Yashaswi/});if(await profileMenu.getAttribute('aria-expanded')!=='true')await profileMenu.click();await page.getByRole('menuitem',{name:'Sign out'}).click();await page.getByLabel('Email').fill('phase2-approver@synthetic.example');await page.getByLabel('Password').fill('golden-local-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();const agentResponse=page.waitForResponse(response=>response.url().endsWith('/api/agents'));await page.getByRole('link',{name:/Approval matrix/}).click();expect((await agentResponse).status()).toBe(200);await expect(page.getByText('Golden governed listing · version 1 · Awaiting approval')).toBeVisible();await page.getByRole('button',{name:'Approve version 1'}).click();await expect(page.getByRole('status')).toContainText('Version 1 approved');
 const approverMenu=page.getByRole('button',{name:/Yashaswi/});if(await approverMenu.getAttribute('aria-expanded')!=='true')await approverMenu.click();await page.getByRole('menuitem',{name:'Sign out'}).click();await page.getByLabel('Email').fill('phase2-owner@synthetic.example');await page.getByLabel('Password').fill('golden-local-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('link',{name:/Agents/}).click();await expect(page.getByText('Golden governed listing · version 1 · Approved')).toBeVisible();await page.getByRole('button',{name:'Run version 1'}).click();await expect(page.getByRole('status')).toContainText('Governed run');
});

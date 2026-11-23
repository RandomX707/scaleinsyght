import { expect,test } from '@playwright/test';

test('phase0_golden_login_reaches_empty_home_and_tenant_usage',async({page})=>{
 await page.goto('/login');
 await expect(page.getByRole('heading',{name:'Welcome to Scale Insyght'})).toBeVisible();
 await page.getByLabel('Email').fill('analyst@north.example');
 await page.getByLabel('Password').fill('golden-local-only');
 await page.getByRole('button',{name:'Sign in'}).click();
 await expect(page).toHaveURL('/');
 await expect(page.getByText('Analytic mode · read-only')).toBeVisible();
 await expect(page.getByRole('heading',{name:'What would you like to understand?'})).toBeVisible();
 const workspace=page.getByRole('button',{name:/WORKSPACE/});
 await expect(workspace).toHaveAttribute('aria-expanded','true');
 await workspace.click();await expect(workspace).toHaveAttribute('aria-expanded','false');
 await page.reload();
 await expect(page.getByRole('button',{name:/WORKSPACE/})).toHaveAttribute('aria-expanded','false');
 await page.getByRole('button',{name:/WORKSPACE/}).click();
 await page.getByRole('button',{name:'Workspace profile'}).click();
 await page.getByRole('menuitem',{name:'Usage'}).click();
 await expect(page.getByRole('heading',{name:'Usage'})).toBeVisible();
 await expect(page.getByText('Active users')).toBeVisible();
 await expect(page.getByRole('menuitem',{name:'Sign out'})).toBeVisible();
});

test('phase1_golden_source_activation_profiles_dictionary_and_read_once_notification',async({page})=>{
 await page.goto('/login');
 await page.getByLabel('Email').fill('analyst@north.example');
 await page.getByLabel('Password').fill('golden-local-only');
 await page.getByRole('button',{name:'Sign in'}).click();
 await expect(page).toHaveURL('/');
 await page.getByRole('link',{name:/Connectors/}).click();
 await page.getByRole('button',{name:'Add connector'}).click();
 await page.getByLabel('Source').selectOption({label:'Meridian Keystone (sql server)'});
 await page.getByRole('button',{name:'Test connection'}).click();
 await expect(page.getByRole('heading',{name:'Choose scope'})).toBeVisible();
 await page.getByRole('button',{name:'Start profiling'}).click();
 await expect(page.getByRole('heading',{name:'Discovery complete'})).toBeVisible();
 await expect(page.getByRole('status')).toContainText('499 objects profiled from 500 listed');
 await page.getByRole('button',{name:'Close'}).click();
 const profiledSource=page.getByRole('article').filter({hasText:'sql server'});
 await profiledSource.getByRole('button',{name:'View profile'}).click();
 await expect(page.getByRole('heading',{name:'Profile'})).toBeVisible();
 await expect(page.getByText('500',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Open Dictionary'}).click();
 await expect(page.getByRole('heading',{name:'Dictionary'})).toBeVisible();
 await expect(page.getByText('X_Golden.Table_001',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:/Notifications/}).click();
 await expect(page.getByRole('heading',{name:'Notifications'})).toBeVisible();
 const newNotification=page.getByRole('button',{name:/Discovery completed/});
 await expect(newNotification).toBeVisible();
 await newNotification.click();
 await expect(page.getByText('Earlier',{exact:true})).toBeVisible();
});

test('phase1_keyboard_navigation_and_catalogue_search_use_stored_metadata_only',async({page})=>{
 await page.goto('/login');
 await page.getByLabel('Email').fill('analyst@north.example');
 await page.getByLabel('Password').fill('golden-local-only');
 await page.getByRole('button',{name:'Sign in'}).click();
 await expect(page).toHaveURL('/');
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
 expect(result.matches).toContain('X_Golden.Table_001');
 expect(result.modelRequests).toBe(0);
 expect(modelEndpointRequests).toBe(0);
});

test('phase2_home_persists_analytic_run_and_renders_evidence_and_feedback',async({page})=>{
 await page.goto('/login');await page.getByLabel('Email').fill('analyst@north.example');await page.getByLabel('Password').fill('golden-local-only');await page.getByRole('button',{name:'Sign in'}).click();
 await page.getByRole('link',{name:/Connectors/}).click();await page.getByRole('button',{name:'Add connector'}).click();await page.getByLabel('Source').selectOption({label:'Meridian Keystone (sql server)'});await page.getByRole('button',{name:'Test connection'}).click();await page.getByRole('button',{name:'Start profiling'}).click();await page.getByRole('button',{name:'Close'}).click();
 await page.getByRole('link',{name:/Home/}).click();await page.getByLabel('Your question').fill('For Meridian Keystone, how many catalog objects are listed? Case 1.');await page.getByRole('button',{name:'Ask question'}).click();
 await expect(page.getByRole('heading',{name:'Run completed',exact:false})).toBeVisible({timeout:15000});await expect(page.getByText(/Synthetic result: 500/)).toHaveCount(2);await expect(page.getByText(/Evidence:/).first()).toBeVisible();await expect(page.getByText(/Trust:/)).toBeVisible();await page.reload();await expect(page.getByRole('heading',{name:'Run completed',exact:false})).toBeVisible();await expect(page.getByText(/Evidence:/).first()).toBeVisible();await page.getByRole('button',{name:'Useful',exact:true}).click();await expect(page.getByRole('status')).toContainText('Feedback saved');
 await page.getByRole('button',{name:'Agents'}).click();await expect(page.getByRole('heading',{name:'My agent'})).toBeVisible();await page.getByLabel('Answer style').selectOption('detailed');await page.getByRole('button',{name:'Save my agent'}).click();await expect(page.getByRole('status')).toContainText('Personal agent settings saved');
 await page.getByLabel('Name').fill('Golden governed listing');await page.getByLabel('Question').fill('For Meridian Keystone, how many catalog objects are listed? Case 1.');await page.getByRole('button',{name:'Save draft version'}).click();await expect(page.getByRole('status')).toContainText('Draft version 1 saved');
 await page.getByRole('button',{name:'Workspace profile'}).click();await page.getByRole('menuitem',{name:'Sign out'}).click();await page.getByLabel('Email').fill('approver@north.example');await page.getByLabel('Password').fill('golden-local-only');await page.getByRole('button',{name:'Sign in'}).click();const agentResponse=page.waitForResponse(response=>response.url().endsWith('/api/agents'));await page.getByRole('link',{name:/Approval matrix/}).click();expect((await agentResponse).status()).toBe(200);await expect(page.getByText('Golden governed listing · version 1 · Awaiting approval')).toBeVisible();await page.getByRole('button',{name:'Approve version 1'}).click();await expect(page.getByRole('status')).toContainText('Version 1 approved');
 await page.getByRole('button',{name:'Workspace profile'}).click();await page.getByRole('menuitem',{name:'Sign out'}).click();await page.getByLabel('Email').fill('analyst@north.example');await page.getByLabel('Password').fill('golden-local-only');await page.getByRole('button',{name:'Sign in'}).click();await page.getByRole('link',{name:/Agents/}).click();await expect(page.getByText('Golden governed listing · version 1 · Approved')).toBeVisible();await page.getByRole('button',{name:'Run version 1'}).click();await expect(page.getByRole('status')).toContainText('Governed run');
});

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
 await page.getByRole('link',{name:/Usage/}).click();
 await expect(page.getByRole('heading',{name:'Usage'})).toBeVisible();
 await expect(page.getByText('Active users')).toBeVisible();
 await page.getByRole('button',{name:'Workspace profile'}).click();
 await expect(page.getByRole('menuitem',{name:'Sign out'})).toBeVisible();
});

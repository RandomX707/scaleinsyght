import { expect,test,type Page } from '@playwright/test';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { hashPassword } from '@scaleinsyght/api/server';
import { activateConnection } from '@scaleinsyght/registry';
import { withTenant } from '@scaleinsyght/db';

config({path:'.env'});
function testUrl(key:'DATABASE_URL'|'DATABASE_URL_MIGRATE'){const value=process.env[key];if(!value)throw new Error(`${key} is required for Phase 6 E2E setup`);const url=new URL(value);url.pathname='/si_test';return url.toString();}
const setup=new Pool({connectionString:testUrl('DATABASE_URL_MIGRATE')});const app=new Pool({connectionString:testUrl('DATABASE_URL')});
test.afterAll(async()=>{await setup.end();await app.end();});

async function createTenant(){
  const tenantId='phase6-e2e-gateway-sso';const userId='6f93817c-058a-4fe9-b46b-ed198f783e91';const email='admin@phase6-e2e-gateway-sso.synthetic.invalid';
  await withTenant(setup,tenantId,async(db)=>{await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1) ON CONFLICT(tenant_id) DO NOTHING',[tenantId]);await db.query('INSERT INTO core.users(tenant_id,user_id,email,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,user_id) DO UPDATE SET email=EXCLUDED.email,password_hash=EXCLUDED.password_hash',[tenantId,userId,email,hashPassword('phase6-ui-password',userId)]);await db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,allowed) VALUES($1,$2,'tenant.gateway.manage',true),($1,$2,'tenant.sso.configure',true),($1,$2,'analytic.read',true)",[tenantId,userId]);});
  await withTenant(setup,tenantId,db=>db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true) ON CONFLICT(tenant_id,capability_id) DO UPDATE SET enabled=true,effect_class='READ',effect_safety='not_applicable'",[tenantId]));
  const source=await activateConnection(app,{tenantId,principalId:userId,connectorType:'postgres'});
  return{tenantId,userId,email,sourceId:source.connectionId};
}
async function signIn(page:Page,email:string){await page.goto('/login');await page.getByLabel('Email').fill(email);await page.getByLabel('Password').fill('phase6-ui-password');const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/login');await page.getByRole('button',{name:'Sign in',exact:true}).click();expect((await pending).status()).toBe(200);await page.waitForURL(url=>url.pathname==='/');}

test('phase6_gateway_and_sso_settings_ui_shows_secret_once_and_never_again',async({page})=>{
  const tenant=await createTenant();await signIn(page,tenant.email);await page.getByRole('link',{name:/Connectors/}).click();
  await page.getByLabel('Gateway source').selectOption(tenant.sourceId);await page.getByRole('button',{name:'Issue gateway enrollment token'}).click();const token=page.getByLabel('One-time gateway enrollment token');await expect(token).toBeVisible();const enrollmentToken=await token.textContent();expect(typeof enrollmentToken==='string'&&/^[a-f0-9]{64}$/.test(enrollmentToken)).toBe(true);
  await page.reload();await page.getByRole('link',{name:/Connectors/}).click();await expect(page.getByLabel('One-time gateway enrollment token')).toHaveCount(0);
  await page.goto(`/controls?connection=${tenant.sourceId}`);await page.getByLabel('OIDC issuer').fill('https://issuer.synthetic.invalid/');await page.getByLabel('OIDC client ID').fill('phase6-synthetic-client');await page.getByLabel('OIDC client secret reference').fill('OIDC_TEST_CLIENT_SECRET');await page.getByLabel('Allowed email domains').fill('synthetic.invalid');await page.getByLabel('Enable OIDC sign-in').check();await page.getByRole('button',{name:'Save SSO settings'}).click();await expect(page.getByRole('status')).toContainText('SSO settings saved');
  await expect(page.getByLabel('OIDC client secret reference')).toHaveValue('OIDC_TEST_CLIENT_SECRET');expect(await page.locator('body').innerText()).not.toContain('synthetic-oidc-client-secret');
  await page.reload();await expect(page.getByLabel('OIDC client secret reference')).toHaveValue('OIDC_TEST_CLIENT_SECRET');expect(await page.locator('body').innerText()).not.toContain('synthetic-oidc-client-secret');
});

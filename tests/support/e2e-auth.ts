import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

export function workspaceForTestEmail(email: string): string {
  for (const file of readdirSync(resolve('tests/golden')).filter(name => name.endsWith('.json'))) {
    const document = JSON.parse(readFileSync(resolve('tests/golden', file), 'utf8')) as { users?: Array<{ email?: string; tenantId?: string }> };
    const user = document.users?.find(candidate => candidate.email?.toLowerCase() === email.toLowerCase());
    if (user?.tenantId) return user.tenantId;
  }
  const domain = email.split('@')[1] ?? '';
  const suffix = ['.synthetic.invalid', '.synthetic.example'].find(candidate => domain.endsWith(candidate));
  const tenantId = suffix ? domain.slice(0, -suffix.length) : '';
  if (tenantId) return tenantId;
  throw new Error(`No test workspace is configured for ${email}`);
}

export async function signInToTestWorkspace(page: Page, email: string, password = 'golden-local-only'): Promise<void> {
  if (new URL(page.url()).pathname !== '/login') await page.goto('/login');
  await page.getByLabel('Workspace ID').fill(workspaceForTestEmail(email));
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await pending;
  if (!response.ok()) throw new Error(`Test workspace login failed with ${response.status()}`);
  await page.waitForURL(url => url.pathname === '/');
}

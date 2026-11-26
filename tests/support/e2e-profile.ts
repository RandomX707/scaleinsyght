import { expect, type Page } from '@playwright/test';

/** Activation queues the discovery profile and returns at once (decision 57); walkthroughs wait for the worker. */
export async function waitForProfile(page: Page, connectionId: string, timeout = 300_000): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/connections/${connectionId}/profile`);
    const profile = (await response.json() as { profile: { state: string; failure_code: string | null } | null }).profile;
    if (profile && (profile.state === 'FAILED' || profile.state === 'PARTIAL')) throw new Error(`discovery ${profile.state}: ${profile.failure_code}`);
    return profile?.state;
  }, { timeout, intervals: [500, 1000, 2000] }).toBe('COMPLETED');
}

export async function activateAndWait(page: Page, connectionId: string): Promise<void> {
  expect((await page.request.post(`/api/connections/${connectionId}/activate`, { data: { scope: [] } })).ok()).toBeTruthy();
  await waitForProfile(page, connectionId);
}

/** After "Start profiling": the Profile page opens at once, orange while profiling, and turns green when complete. */
export async function expectProfilePageCompletes(page: Page, timeout = 300_000): Promise<string> {
  await expect(page).toHaveURL(/\/profile\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByRole('img', { name: 'Profiling complete' })).toBeVisible({ timeout });
  await expect(page.getByRole('list', { name: 'Profiling steps' }).getByRole('listitem')).toHaveCount(4);
  for (const item of await page.getByRole('list', { name: 'Profiling steps' }).getByRole('listitem').all()) await expect(item).toHaveClass(/is-done/);
  return new URL(page.url()).pathname.split('/')[2]!;
}

import { expect, test } from '@playwright/test';
import { registerViaApi } from '../helpers';

test.describe.serial('settings & PWA journeys', () => {
  let account: Awaited<ReturnType<typeof registerViaApi>>;

  test.beforeAll(async () => {
    account = await registerViaApi('Settings Tester');
  });

  async function login(page: import('@playwright/test').Page) {
    await page.goto('/login');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard');
  }

  test('profile save persists display name; forwarding address renders', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/settings');

    const nameInput = page.getByLabel('Display name');
    await nameInput.fill('Settings Tester Renamed');
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText('Settings saved')).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('code', { hasText: /^deadline\+[a-f0-9]+@/ })).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Display name')).toHaveValue('Settings Tester Renamed');
  });

  test('theme toggle switches dark class on <html>', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/settings');

    const html = page.locator('html');
    await page.getByRole('button', { name: 'Dark theme' }).click();
    await expect(html).toHaveClass(/dark/);
    await page.getByRole('button', { name: 'Light theme' }).click();
    await expect(html).not.toHaveClass(/dark/);
  });

  test('PWA assets: manifest link present, service worker registers, icons resolve', async ({ page, request }) => {
    await login(page);

    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);
    const manifestJson = (await manifest.json()) as { icons: Array<{ src: string }> };
    expect(manifestJson.icons.length).toBeGreaterThanOrEqual(2);

    for (const icon of ['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']) {
      const res = await request.get(icon);
      expect(res.status(), icon).toBe(200);
    }

    await page.waitForFunction(
      async () => {
        if (!navigator.serviceWorker) return false;
        const regs = await navigator.serviceWorker.getRegistrations();
        return regs.length > 0;
      },
      undefined,
      { timeout: 15_000 }
    );
    void expect;
  });
});

import { expect, test } from '@playwright/test';
import { registerViaApi, seedEvent } from '../helpers';

test.use({ viewport: { width: 390, height: 844 } });

test('SSE bell updates live when the outbox delivers a reminder', async ({ page }) => {
  test.setTimeout(240_000);
  const account = await registerViaApi('SSE Tester');

  await test.step('login through UI', async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard');
  });

  await test.step('seed event due in ~100s with an at-fire in-app reminder via API', async () => {
    const dueAt = new Date(Date.now() + 100_000).toISOString();
    await seedEvent(account.accessToken, {
      title: 'SSE live delivery probe',
      dueAt,
      reminders: [{ offsetSeconds: 0, channel: 'in_app' }]
    });
  });

  const bell = page.locator('a[aria-label^="Notifications"]:visible');

  let baseline = 1;
  await test.step('bell is visible and reports a baseline count (welcome alert = 1)', async () => {
    await expect(bell).toBeVisible();
    await expect
      .poll(async () => (await bell.getAttribute('aria-label')) ?? '', { timeout: 10_000 })
      .toContain('unread');
    const label = (await bell.getAttribute('aria-label')) ?? '';
    baseline = Number(/(\d+) unread/.exec(label)?.[1] ?? 1);
  });

  await test.step(
    'unread badge appears without any reload within ~3.5 minutes (planner 60s + outbox 30s cycles)',
    async () => {
      await expect
        .poll(
          async () => {
            const label = (await bell.getAttribute('aria-label')) ?? '';
            const match = /\((\d+) unread\)/.exec(label);
            return match ? Number(match[1]) : 0;
          },
          { timeout: 210_000, intervals: [2_000, 5_000, 10_000] }
        )
        .toBeGreaterThan(baseline);
    }
  );

  await test.step('notifications page lists the delivered reminder', async () => {
    await bell.click();
    await page.waitForURL('**/dashboard/notifications');
    await expect(page.getByText(/SSE live delivery probe/i).first()).toBeVisible();
  });

  void expect;
});

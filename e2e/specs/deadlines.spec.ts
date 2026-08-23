import { expect, test } from '@playwright/test';
import { registerViaApi } from '../helpers';

test.describe.serial('deadline CRUD journeys', () => {
  let account: Awaited<ReturnType<typeof registerViaApi>>;

  test.beforeAll(async () => {
    account = await registerViaApi('CRUD Tester');
  });

  async function login(page: import('@playwright/test').Page) {
    await page.goto('/login');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard');
  }

  test('create deadline via manual form shows card with badge', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/events/new');

    await page.getByLabel('Title').fill('E2E Playwright midterm');
    await page.getByLabel('Type').selectOption('exam');

    const due = new Date(Date.now() + 26 * 3600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const local = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T${pad(due.getHours())}:${pad(due.getMinutes())}`;
    await page.fill('input[type="datetime-local"]', local);

    await page.getByRole('button', { name: /create deadline/i }).click();
    await page.waitForURL('**/dashboard');

    await expect(page.getByRole('heading', { name: 'E2E Playwright midterm' })).toBeVisible();
    const statusChip = page.locator('.group', { hasText: 'E2E Playwright midterm' }).locator('.chip', { hasText: /upcoming|due soon/i });
    await expect(statusChip).toHaveCount(1);
  });

  test('edit flow persists a new title', async ({ page }) => {
    await login(page);
    const row = page.locator('.group', { hasText: 'E2E Playwright midterm' }).first();
    await row.getByRole('link', { name: /edit/i }).click();
    await page.waitForURL(/\/dashboard\/events\/.+\/edit/);
    await page.getByLabel('Title').fill('E2E Playwright midterm — edited');
    await page.getByRole('button', { name: /save changes/i }).click();
    await page.waitForURL('**/dashboard');
    await expect(page.getByText('E2E Playwright midterm — edited')).toBeVisible();
  });

  test('done action moves card to Done filter; delete removes permanently', async ({ page }) => {
    await login(page);
    const title = 'E2E Playwright midterm — edited';
    const card = page.locator('.group', { hasText: title }).first();

    await card.getByRole('button', { name: /^done$/i }).click();
    await expect(card).toBeHidden({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByText(title)).toBeVisible();

    const doneCard = page.locator('.group', { hasText: title }).first();
    await doneCard.hover();
    await doneCard.locator('button[aria-label^="Delete"]').click();
    await expect(page.getByText(title)).toBeHidden({ timeout: 15_000 });
  });

  test('snooze shifts an overdue card back to future', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/events/new');
    await page.getByLabel('Title').fill('E2E snooze target');
    const past = new Date(Date.now() - 4 * 3600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    await page.fill(
      'input[type="datetime-local"]',
      `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`
    );
    await page.getByRole('button', { name: /create deadline/i }).click();
    await page.waitForURL('**/dashboard');

    const overdueCard = page.locator('.group', { hasText: 'E2E snooze target' }).first();
    await expect(overdueCard.locator('.chip', { hasText: /overdue/i })).toBeVisible();

    await overdueCard.getByRole('button', { name: /snooze 1d/i }).click();
    await expect(overdueCard.locator('.chip', { hasText: /overdue/i })).toBeHidden({ timeout: 15_000 });
  });
});

import { expect, test } from '@playwright/test';
import { uniqueEmail, registerViaApi } from '../helpers';

test.describe('landing & auth journeys', () => {
  test('landing page renders for logged-out visitor', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/never miss/i);
    await expect(page.getByRole('link', { name: /get started/i })).toBeVisible();
  });

  test('register through the UI lands on dashboard', async ({ page }) => {
    const email = uniqueEmail();
    await page.goto('/register');
    await page.getByLabel('Display name').fill('Playwright User');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('Passw0rd!42');
    await page.getByLabel('Confirm', { exact: true }).fill('Passw0rd!42');
    await page.getByRole('button', { name: /create account/i }).click();
    await page.waitForURL('**/dashboard');
    await expect(page.getByText('Everything that is due', { exact: false })).toBeVisible();
  });

  test('logout returns to login and session stays dead', async ({ page }) => {
    const account = await registerViaApi('Logout Tester');
    await page.goto('/login');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/dashboard');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await page.waitForURL('**/login');
    await page.goto('/dashboard');
    await page.waitForURL('**/login');
  });
});

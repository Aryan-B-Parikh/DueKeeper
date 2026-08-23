import { expect, test } from '@playwright/test';
import { API_URL } from '../helpers';

test('API and web are reachable before suites run', async ({ request }) => {
  const health = await request.get(`${API_URL}/api/health`);
  expect(health.status()).toBe(200);

  const web = await request.get('/login');
  expect(web.status()).toBe(200);
});

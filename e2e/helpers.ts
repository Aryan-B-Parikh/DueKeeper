import { APIRequestContext, request as playwrightRequest } from '@playwright/test';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8081';

export interface TestAccount {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

let apiContext: APIRequestContext | null = null;

export async function getApi(): Promise<APIRequestContext> {
  if (!apiContext) {
    apiContext = await playwrightRequest.newContext({ baseURL: API_URL });
  }
  return apiContext;
}

export function uniqueEmail(): string {
  return `e2e_${Date.now()}_${Math.floor(Math.random() * 10_000)}@test.local`;
}

export async function registerViaApi(
  displayName = 'E2E Tester'
): Promise<TestAccount & { displayName: string }> {
  const api = await getApi();
  const email = uniqueEmail();
  const password = 'Passw0rd!42';
  const res = await api.post('/api/auth/register', {
    data: { email, password, displayName }
  });
  if (!res.ok()) {
    throw new Error(`register failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string; refreshToken: string };
  return { email, password, accessToken: body.accessToken, refreshToken: body.refreshToken, displayName };
}

export async function seedEvent(
  token: string,
  input: { title: string; dueAt?: string; eventType?: string; reminders?: Array<{ offsetSeconds: number; channel: 'in_app' | 'email' }> }
): Promise<{ id: string }> {
  const api = await getApi();
  const res = await api.post('/api/events', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: input.title,
      eventType: input.eventType ?? 'exam',
      dueAt: input.dueAt ?? new Date(Date.now() + 24 * 3600_000).toISOString(),
      timezone: 'UTC',
      ...(input.reminders ? { reminders: input.reminders } : {})
    }
  });
  if (!res.ok()) {
    throw new Error(`seed event failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { event: { id: string } };
  return { id: body.event.id };
}

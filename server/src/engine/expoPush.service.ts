import { prepare } from '../db/database';
import { createLogger } from '../lib/logger';
import { config } from '../config/env';

const log = createLogger('expo-push');

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushInput {
  title: string;
  body: string;
  url?: string;
}

export async function sendExpoToUser(userId: string, input: ExpoPushInput): Promise<{ sent: number; removed: number }> {
  const rows = prepare('SELECT token FROM expo_push_tokens WHERE user_id = ?').all(userId) as Array<{
    token: string;
  }>;
  if (rows.length === 0) return { sent: 0, removed: 0 };

  const messages = rows.map((row) => ({
    to: row.token,
    sound: 'default' as const,
    title: input.title,
    body: input.body,
    data: { url: input.url ?? '/dashboard/notifications' }
  }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.outboundFetchTimeoutMs);
  try {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
      signal: controller.signal
    });
    if (!response.ok) {
      log.warn(`Expo push API returned ${response.status}`);
      return { sent: 0, removed: 0 };
    }
    // The body read stays inside the timeout window: a server that sends headers
    // and then stalls mid-body would otherwise hang here indefinitely, because
    // clearing the timer immediately after fetch() resolves leaves the read
    // unprotected.
    const payload = (await response.json()) as {
      data?: Array<{ status?: string; error?: string }>;
    };
    let sent = 0;
    let removed = 0;
    payload.data?.forEach((item, index) => {
      if (item.status === 'ok') {
        sent += 1;
        return;
      }
      if (item.error === 'DeviceNotRegistered') {
        prepare('DELETE FROM expo_push_tokens WHERE token = ?').run(rows[index].token);
        removed += 1;
      } else {
        log.warn(`Expo push error for token ${index}: ${item.error ?? 'unknown'}`);
      }
    });
    return { sent, removed };
  } catch (err) {
    log.warn('Expo push delivery failed', err as Error);
    return { sent: 0, removed: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

import { prepare, queryAll } from '../db/database';
import { createLogger } from '../lib/logger';
import { sendWebPush } from '../lib/push/webpush';
import { getVapidKeys } from '../lib/push/vapid';
import { metrics } from '../lib/metrics';

const log = createLogger('push');

export interface PushNotificationInput {
  title: string;
  body: string;
  url?: string;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function pushAvailable(): boolean {
  return Boolean(getVapidKeys());
}

export async function sendPushToUser(userId: string, notification: PushNotificationInput): Promise<{ sent: number; removed: number }> {
  if (!pushAvailable()) return { sent: 0, removed: 0 };
  const rows = queryAll<SubscriptionRow>(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    userId
  );

  let sent = 0;
  let removed = 0;
  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        const result = await sendWebPush(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          notification
        );
        if (result.ok) {
          sent += 1;
          metrics.pushesSent += 1;
        } else if (result.gone) {
          prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
          removed += 1;
        } else {
          // Include status 0 (network/timeout) — previously suppressed, hiding total push outage.
          metrics.pushesFailed = (metrics.pushesFailed ?? 0) + 1;
          log.warn(`Push to ${row.endpoint.slice(0, 48)}… failed with status ${result.status}`);
        }
      } catch (err) {
        // Counted as well as logged: a thrown error is still a push the user
        // never got, and an uncounted one makes the failure metric lie.
        metrics.pushesFailed = (metrics.pushesFailed ?? 0) + 1;
        log.warn('Push delivery failed unexpectedly', err as Error);
      }
    })
  );
  return { sent, removed };
}

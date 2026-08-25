import { insertNotification } from '../modules/auth/auth.service';
import { publishNotification, type LiveNotification } from './hub';
import { sendPushToUser } from './push.service';
import { sendExpoToUser } from './expoPush.service';
import { createLogger } from '../lib/logger';

const log = createLogger('notifier');

export interface NotifyInput {
  eventId?: string | null;
  idempotencyKey?: string;
}

export function notifyInApp(
  userId: string,
  type: 'reminder' | 'system' | 'info' | 'warning',
  title: string,
  body: string,
  options?: NotifyInput
): LiveNotification | null {
  return insertNotification(userId, type, title, body, options);
}

export function notifyEverywhere(
  userId: string,
  type: 'reminder' | 'system' | 'info' | 'warning',
  title: string,
  body: string,
  options?: NotifyInput
): LiveNotification | null {
  const notification = notifyInApp(userId, type, title, body, options);
  if (!notification) return null;
  publishNotification(userId, notification);
  void sendPushToUser(userId, { title, body, url: '/dashboard/notifications' }).catch((err) => {
    // Previously swallowed with () => undefined — obscured that web push never worked.
    log.warn('Web push fan-out failed', err as Error);
  });
  void sendExpoToUser(userId, { title, body, url: 'duekeeper://(tabs)/notifications' }).catch((err) => {
    log.warn('Expo push fan-out failed', err as Error);
  });
  return notification;
}

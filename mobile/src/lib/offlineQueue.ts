import AsyncStorage from '@react-native-async-storage/async-storage';
import { isOnline } from './offline';
import { eventsApi, type EventItem } from './api';

const QUEUE_KEY = 'duekeeper:offline:queue';

export type QueuedEvent = {
  id: string;
  title: string;
  eventType: EventItem['eventType'];
  dueAt: string;
  timezone: string;
  createdAt: string;
};

export async function enqueueOffline(event: Omit<QueuedEvent, 'id' | 'createdAt'>): Promise<void> {
  const q = await getQueue();
  // Deduplicate: same title+dueAt already queued (kill→reopen→re-enqueue)
  const dup = q.some((e) => e.title === event.title && e.dueAt === event.dueAt && e.eventType === event.eventType);
  if (dup) return;
  q.push({ ...event, id: `offline-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, createdAt: new Date().toISOString() });
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

export async function getQueue(): Promise<QueuedEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) as QueuedEvent[] : [];
  } catch { return []; }
}

export async function syncQueue(): Promise<{ synced: number; remaining: number }> {
  if (!(await isOnline())) return { synced: 0, remaining: (await getQueue()).length };
  const q = await getQueue();
  let synced = 0;
  const remaining: QueuedEvent[] = [];
  for (const item of q) {
    try {
      await eventsApi.create({
        title: item.title,
        eventType: item.eventType,
        dueAt: item.dueAt,
        timezone: item.timezone,
        reminders: [{ offsetSeconds: 86400, channel: 'in_app' }]
      });
      synced++;
    } catch (e) {
      const err = e as { status?: number; code?: string };
      // 401 (revoked/expired) — don't retry forever, drop and force re-login; user will see login screen on next load
      if (err?.status === 401 || err?.code === 'UNAUTHORIZED') {
        // Drop the item; retrying with an expired session will never succeed
        continue;
      }
      remaining.push(item);
    }
  }
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  return { synced, remaining: remaining.length };
}

export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_KEY);
}

import { EventEmitter } from 'events';
import { prepare } from '../db/database';

export interface LiveNotification {
  id: string;
  eventId: string | null;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

type Listener = (event: 'notification' | 'unread', payload: unknown) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const listeners = new Map<string, Set<Listener>>();

function countUnread(userId: string): number {
  const row = prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0').get(
    userId
  ) as { c: number };
  return Number(row.c);
}

export function subscribe(userId: string, listener: Listener): Listener {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);
  return listener;
}

export function unsubscribe(userId: string, listener: Listener): void {
  const set = listeners.get(userId);
  if (!set) return;
  set.delete(listener);
  if (set.size === 0) listeners.delete(userId);
}

function emitTo(userId: string, event: 'notification' | 'unread', payload: unknown): void {
  const set = listeners.get(userId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event, payload);
    } catch {
      /* a broken stream must not break delivery */
    }
  }
}

export function publishNotification(userId: string, notification: LiveNotification | null): void {
  if (notification) {
    emitTo(userId, 'notification', notification);
  }
  emitTo(userId, 'unread', { count: countUnread(userId) });
}

export function publishUnread(userId: string): void {
  emitTo(userId, 'unread', { count: countUnread(userId) });
}

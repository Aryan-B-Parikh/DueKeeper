'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BellRing, CheckCheck, RefreshCw } from 'lucide-react';
import { notificationsApi, type AppNotification } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/Toast';

export default function NotificationsPage() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { notifications } = await notificationsApi.list({ limit: 100 });
      setItems(notifications);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notifications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function markRead(id: string) {
    try {
      await notificationsApi.markRead(id);
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to mark as read');
    }
  }

  async function markAll() {
    try {
      await notificationsApi.markAllRead();
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      toast('success', 'All caught up');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to update');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-sm text-ink-soft">Reminders delivered by the DueKeeper engine.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void load()} className="btn-ghost" aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </button>
          <button onClick={markAll} className="btn-ghost">
            <CheckCheck className="h-4 w-4" /> Mark all read
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="neu-card h-20 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="neu-card p-8 text-center text-sm text-danger">{error}</div>
      ) : items.length === 0 ? (
        <div className="neu-card flex flex-col items-center gap-3 p-10 text-center">
          <BellRing className="h-8 w-8 text-accent" />
          <p className="font-semibold">No notifications yet</p>
          <p className="max-w-sm text-sm text-ink-soft">
            When a reminder fires you will see it here. Add deadlines with reminders to get started.
          </p>
          <Link href="/dashboard/events/new" className="btn-primary mt-1">
            Add deadline
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((n) => (
            <button
              key={n.id}
              onClick={() => !n.read && void markRead(n.id)}
              className={cn(
                'neu-card block w-full p-4 text-left transition',
                !n.read && 'border-l-4 border-l-accent',
                n.read && 'opacity-70'
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <p className={cn('text-sm', n.read ? 'font-medium' : 'font-bold')}>{n.title}</p>
                {!n.read && <span className="chip bg-accent-soft text-accent">New</span>}
              </div>
              <p className="mt-1 text-sm text-ink-soft">{n.body}</p>
              <p className="mt-1.5 text-xs text-ink-soft/70">{new Date(n.createdAt).toLocaleString()}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

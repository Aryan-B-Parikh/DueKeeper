'use client';

import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { getToken, notificationsApi } from '@/lib/api';
import { API_URL } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { cn } from '@/lib/utils';

export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const { toast } = useToast();

  useEffect(() => {
    let alive = true;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const fallbackPoll = setInterval(() => {
      notificationsApi
        .unreadCount()
        .then((r) => {
          if (alive) setUnread(r.unreadCount);
        })
        .catch(() => {});
    }, 120_000);

    function connect() {
      const token = getToken();
      if (!token || !alive) return;
      source = new EventSource(`${API_URL}/api/notifications/stream?token=${encodeURIComponent(token)}`);
      source.addEventListener('unread', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { count: number };
          setUnread(data.count);
        } catch {
          /* ignore malformed frames */
        }
      });
      source.addEventListener('notification', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { title: string };
          toast('info', data.title);
        } catch {
          /* ignore malformed frames */
        }
      });
      source.onopen = () => {};
      source.onerror = () => {
        source?.close();
        source = null;
        if (alive) {
          reconnectTimer = setTimeout(connect, 30_000);
        }
      };
    }

    notificationsApi
      .unreadCount()
      .then((r) => {
        if (alive) setUnread(r.unreadCount);
      })
      .catch(() => {});
    connect();

    return () => {
      alive = false;
      clearInterval(fallbackPoll);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <a
      href="/dashboard/notifications"
      className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-surface text-ink-soft shadow-neu-sm transition hover:text-accent"
      aria-label={`Notifications (${unread} unread)`}
    >
      <Bell className="h-5 w-5" />
      <span
        className={cn(
          'absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-danger transition-opacity',
          unread === 0 && 'opacity-0'
        )}
      />
      {unread > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </a>
  );
}

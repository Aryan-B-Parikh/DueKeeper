'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BellRing, Check, Clock3, PencilLine, Trash2 } from 'lucide-react';
import type { EventItem } from '@/lib/api';
import { eventsApi } from '@/lib/api';
import { cn, formatDueFull, formatDueRelative } from '@/lib/utils';
import { typeIcons } from '@/lib/meta';
import { StatusBadge } from './StatusBadge';

interface EventCardProps {
  event: EventItem;
  onChanged: () => void;
}

export function EventCard({ event, onChanged }: EventCardProps) {
  const [busy, setBusy] = useState(false);
  const Icon = typeIcons[event.eventType];
  const terminal = event.status === 'done' || event.status === 'cancelled';

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch {
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        'neu-card group flex flex-col gap-3 p-4 transition hover:-translate-y-0.5 animate-fade-up',
        terminal && 'opacity-70'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-neu-sm',
              event.status === 'overdue' ? 'bg-danger/15 text-danger' : 'bg-accent-soft text-accent'
            )}
          >
            <Icon className="h-5 w-5" />
          </span>
          <div>
            <h3 className={cn('font-semibold leading-snug', terminal && 'line-through decoration-ink-soft/50')}>
              {event.title}
            </h3>
            <p className="text-xs text-ink-soft">
              {formatDueFull(event.dueAt, event.timezone)} · {formatDueRelative(event.dueAt)}
            </p>
          </div>
        </div>
        <StatusBadge status={event.status} />
      </div>

      {event.description && <p className="text-sm text-ink-soft line-clamp-2">{event.description}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {event.reminders.slice(0, 4).map((reminder) => (
          <span key={reminder.id ?? reminder.offsetSeconds} className="chip bg-surface text-ink-soft shadow-neu-inset">
            <BellRing className="h-3 w-3" />
            {formatOffset(reminder.offsetSeconds)} · {reminder.channel === 'email' ? 'Email' : 'In-app'}
          </span>
        ))}
        {event.source !== 'manual' && (
          <span className="chip bg-accent-soft text-accent capitalize">via {event.source.replace('_', ' ')}</span>
        )}
      </div>

      {!terminal && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
          <button
            disabled={busy}
            onClick={() => run(() => eventsApi.markDone(event.id))}
            className="btn-ghost !py-1.5 text-xs"
          >
            <Check className="h-3.5 w-3.5" /> Done
          </button>
          <button
            disabled={busy}
            onClick={() => run(() => eventsApi.snooze(event.id, '1d'))}
            className="btn-ghost !py-1.5 text-xs"
          >
            <Clock3 className="h-3.5 w-3.5" /> Snooze 1d
          </button>
          <Link href={`/dashboard/events/${event.id}/edit`} className="btn-ghost !py-1.5 text-xs">
            <PencilLine className="h-3.5 w-3.5" /> Edit
          </Link>
          <button
            disabled={busy}
            onClick={() => run(() => eventsApi.cancel(event.id))}
            className="btn-ghost !py-1.5 text-xs"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            onClick={() => run(() => eventsApi.remove(event.id))}
            className="ml-auto rounded-lg p-1.5 text-ink-soft transition hover:bg-danger/10 hover:text-danger"
            aria-label={`Delete ${event.title}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}

      {terminal && (
        <div className="flex justify-end border-t border-line/60 pt-3">
          <button
            disabled={busy}
            onClick={() => run(() => eventsApi.remove(event.id))}
            className="rounded-lg p-1.5 text-ink-soft transition hover:bg-danger/10 hover:text-danger"
            aria-label={`Delete ${event.title}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function formatOffset(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d before`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h before`;
  return `${Math.round(seconds / 60)}m before`;
}

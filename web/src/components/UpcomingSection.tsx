'use client';

import type { EventItem } from '@/lib/api';
import { EventCard } from '@/components/EventCard';
import { formatDueRelative } from '@/lib/utils';

interface UpcomingSectionProps {
  events: EventItem[];
  onChanged: () => void;
}

function startOfDayInZone(date: Date, timeZone: string): Date {
  // Get YYYY-MM-DD in target zone, then interpret as UTC midnight for comparison
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(date);
  const y = Number(parts.find(p => p.type === 'year')?.value);
  const m = Number(parts.find(p => p.type === 'month')?.value) - 1;
  const d = Number(parts.find(p => p.type === 'day')?.value);
  return new Date(Date.UTC(y, m, d));
}

function groupByDay(events: EventItem[], timeZone: string) {
  const todayStart = startOfDayInZone(new Date(), timeZone);
  const tomorrowStart = new Date(todayStart.getTime() + 86400000);
  const weekEnd = new Date(todayStart.getTime() + 7 * 86400000);
  const groups: { label: string; items: EventItem[] }[] = [
    { label: 'TODAY', items: [] },
    { label: 'THIS WEEK', items: [] },
    { label: 'LATER', items: [] },
  ];
  // Overdue goes to TODAY (needs attention now) — matches product spec
  for (const e of events) {
    const due = new Date(e.dueAt);
    const dueDay = startOfDayInZone(due, e.timezone || timeZone);
    if (e.status === 'overdue' || dueDay.getTime() === todayStart.getTime()) groups[0].items.push(e);
    else if (dueDay < weekEnd) groups[1].items.push(e);
    else groups[2].items.push(e);
  }
  // Sort within groups by dueAt
  for (const g of groups) g.items.sort((a,b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  return groups.filter(g => g.items.length > 0);
}

export function UpcomingSection({ events, onChanged }: UpcomingSectionProps) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const groups = groupByDay(events, timeZone);
  if (events.length === 0) {
    return (
      <div className="neu-card p-8 text-center animate-fade-up">
        <p className="text-lg font-semibold">No upcoming deadlines</p>
        <p className="mt-1 text-sm text-ink-soft">Add your first deadline — you’ll see it here grouped by when it’s due.</p>
        <a href="/dashboard/events/new" className="btn-primary mt-4 inline-flex">Add deadline</a>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {groups.map(group => (
        <section key={group.label}>
          <h2 className="mb-3 text-xs font-bold tracking-widest text-ink-soft">{group.label}</h2>
          <div className="grid gap-3">
            {group.items.map(ev => (
              <EventCard key={ev.id} event={ev} onChanged={onChanged} />
            ))}
          </div>
        </section>
      ))}
      {events.length > 20 && (
        <p className="text-center text-xs text-ink-soft">Showing {events.length} — use filters for more</p>
      )}
    </div>
  );
}

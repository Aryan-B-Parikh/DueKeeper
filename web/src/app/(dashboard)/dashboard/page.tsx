'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw, Search } from 'lucide-react';
import { eventsApi, type EventItem, type EventStatus } from '@/lib/api';
import { EventCard } from '@/components/EventCard';

type Filter = 'active' | 'upcoming' | 'due_soon' | 'overdue' | 'done' | 'all';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'active', label: 'Active' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'due_soon', label: 'Due soon' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'done', label: 'Done' },
  { key: 'all', label: 'All' }
];

export default function OverviewPage() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [filter, setFilter] = useState<Filter>('active');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { events: list } = await eventsApi.list({ status: filter });
      setEvents(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load events');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const by = (status: EventStatus) =>
      events.filter((e) => e.status === status).length;
    return { upcoming: by('upcoming'), dueSoon: by('due_soon'), overdue: by('overdue') };
  }, [events]);

  const visibleEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q)
    );
  }, [events, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Overview</h1>
          <p className="text-sm text-ink-soft">Everything that is due, at a glance.</p>
        </div>
        <Link href="/dashboard/events/new" className="btn-primary">
          <Plus className="h-4 w-4" /> Add deadline
        </Link>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search deadlines…"
          className="neu-input !pl-10"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Upcoming" value={stats.upcoming} tone="accent" />
        <StatCard label="Due soon" value={stats.dueSoon} tone="warn" />
        <StatCard label="Overdue" value={stats.overdue} tone="danger" />
        <StatCard label="Shown" value={visibleEvents.length} tone="muted" />
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={
              filter === key
                ? 'rounded-xl bg-accent-soft px-4 py-2 text-sm font-semibold text-accent shadow-neu-inset'
                : 'rounded-xl bg-surface px-4 py-2 text-sm font-medium text-ink-soft shadow-neu-sm transition hover:text-ink'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="neu-card h-28 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="neu-card flex flex-col items-center gap-3 p-8 text-center">
          <p className="text-sm text-danger">{error}</p>
          <button onClick={() => void load()} className="btn-ghost">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      ) : visibleEvents.length === 0 ? (
        query.trim() ? (
          <div className="neu-card p-10 text-center">
            <p className="font-semibold">No matches for “{query.trim()}”</p>
            <p className="mt-1 text-sm text-ink-soft">Try a different keyword or clear the search.</p>
          </div>
        ) : (
          <div className="neu-card flex flex-col items-center gap-3 p-10 text-center">
            <p className="font-semibold">No deadlines here yet</p>
            <p className="max-w-sm text-sm text-ink-soft">
              Create one manually, paste text to auto-extract dates, or import your calendar as .ics.
            </p>
            <Link href="/dashboard/events/new" className="btn-primary mt-1">
              <Plus className="h-4 w-4" /> Add your first deadline
            </Link>
          </div>
        )
      ) : (
        <div className="space-y-3">
          {visibleEvents.map((event) => (
            <EventCard key={event.id} event={event} onChanged={() => void load()} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'accent' | 'warn' | 'danger' | 'muted' }) {
  const tones: Record<string, string> = {
    accent: 'text-accent',
    warn: 'text-warn',
    danger: 'text-danger',
    muted: 'text-ink'
  };
  return (
    <div className="neu-flat p-4">
      <p className={`text-2xl font-bold ${tones[tone]}`}>{value}</p>
      <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-soft">{label}</p>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, CalendarPlus, Download, Upload } from 'lucide-react';
import { eventsApi, calendarApi, type EventItem } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, zonedDateKey, formatDueFull } from '@/lib/utils';
import { typeIcons, statusStyles } from '@/lib/meta';
import { useToast } from '@/components/Toast';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function CalendarPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const timezone = user?.timezone ?? 'UTC';

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { events: list } = await eventsApi.list({ status: 'all' });
        if (alive) setEvents(list);
      } catch {
        /* overview shows errors; calendar stays best-effort */
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const byDay = useMemo(() => {
    const map = new Map<string, EventItem[]>();
    for (const event of events) {
      if (event.status === 'cancelled') continue;
      const key = zonedDateKey(event.dueAt, timezone);
      const list = map.get(key) ?? [];
      list.push(event);
      map.set(key, list);
    }
    return map;
  }, [events, timezone]);

  const grid = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: Array<{ date: Date | null }> = [];
    for (let i = 0; i < firstWeekday; i += 1) cells.push({ date: null });
    for (let day = 1; day <= daysInMonth; day += 1) cells.push({ date: new Date(year, month, day) });
    while (cells.length % 7 !== 0) cells.push({ date: null });
    return cells;
  }, [cursor]);

  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  async function importIcs(file: File) {
    setBusy(true);
    try {
      const result = await calendarApi.importIcs(file);
      toast('success', `Imported ${result.imported} event(s), skipped ${result.skipped}`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  const selectedEvents = selectedDay ? byDay.get(selectedDay) ?? [] : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Calendar</h1>
          <p className="text-sm text-ink-soft">Deadlines laid out across the month ({timezone}).</p>
        </div>
        <div className="flex gap-2">
          <a href={calendarApi.exportUrl()} className="btn-ghost" download="duekeeper.ics">
            <Download className="h-4 w-4" /> Export .ics
          </a>
          <label className="btn-ghost cursor-pointer">
            <Upload className="h-4 w-4" /> Import .ics
            <input
              type="file"
              accept=".ics,text/calendar"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importIcs(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </div>

      <div className="neu-card p-4 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <button
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            className="btn-ghost !p-2.5"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h2 className="font-semibold">
            {cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' })}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
              className="btn-ghost hidden !py-1.5 text-xs sm:inline-flex"
            >
              Today
            </button>
            <button
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
              className="btn-ghost !p-2.5"
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center">
          {WEEKDAYS.map((day) => (
            <div key={day} className="py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
              {day}
            </div>
          ))}
          {grid.map(({ date }, idx) => {
            if (!date) return <div key={`empty-${idx}`} />;
            const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            const dayEvents = byDay.get(key) ?? [];
            const isToday = key === todayKey;
            return (
              <button
                key={key}
                onClick={() => setSelectedDay(selectedDay === key ? null : key)}
                className={cn(
                  'flex min-h-[64px] flex-col items-center rounded-xl border border-transparent p-1 transition hover:border-accent/40 sm:min-h-[84px]',
                  isToday && 'border-accent/60 bg-accent-soft/40',
                  selectedDay === key && 'shadow-neu-inset'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                    isToday ? 'bg-accent text-white' : 'text-ink'
                  )}
                >
                  {date.getDate()}
                </span>
                <div className="mt-1 flex flex-wrap justify-center gap-0.5">
                  {dayEvents.slice(0, 3).map((event) => {
                    const Icon = typeIcons[event.eventType];
                    return (
                      <span
                        key={event.id}
                        className={cn(
                          'flex h-4 w-4 items-center justify-center rounded',
                          statusStyles[event.status] ?? statusStyles.upcoming
                        )}
                        title={`${event.title} — ${formatDueFull(event.dueAt, timezone)}`}
                      >
                        <Icon className="h-2.5 w-2.5" />
                      </span>
                    );
                  })}
                  {dayEvents.length > 3 && (
                    <span className="text-[9px] font-semibold text-ink-soft">+{dayEvents.length - 3}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {selectedDay && (
          <div className="mt-4 space-y-2 border-t border-line/60 pt-4 animate-fade-up">
            <p className="text-sm font-semibold">{selectedDay}</p>
            {selectedEvents.length === 0 ? (
              <p className="text-sm text-ink-soft">Nothing due on this day.</p>
            ) : (
              selectedEvents.map((event) => (
                <div key={event.id} className="neu-flat flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span>{event.title}</span>
                  <Link href="/dashboard/events/new" className="text-xs text-accent hover:underline">
                    details on Overview →
                  </Link>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="neu-card flex flex-col items-start gap-2 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="flex items-center gap-2 font-semibold">
            <CalendarPlus className="h-4 w-4 text-accent" /> Sync with Google Calendar
          </p>
          <p className="text-sm text-ink-soft">One-way sync of deadline-worthy events from your primary calendar.</p>
        </div>
        <Link href="/dashboard/settings" className="btn-ghost shrink-0">
          Connect in Settings →
        </Link>
      </div>
    </div>
  );
}

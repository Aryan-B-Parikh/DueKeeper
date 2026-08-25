'use client';

import { FormEvent, useState } from 'react';
import { CalendarPlus, Save } from 'lucide-react';
import type { EventItem } from '@/lib/api';
import { browserTimezone, datetimeLocalToIso, isoToDatetimeLocal } from '@/lib/utils';
import { ReminderConfig, defaultReminders, type ReminderDraft } from '@/components/ReminderConfig';

interface EventFormProps {
  initial?: EventItem | null;
  submitLabel: string;
  onSubmit: (input: {
    title: string;
    description: string | null;
    eventType: EventItem['eventType'];
    dueAt: string;
    timezone: string;
    reminders: Array<{ offsetSeconds: number; channel: 'email' | 'in_app' }>;
  }) => Promise<void>;
}

export function EventForm({ initial, submitLabel, onSubmit }: EventFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [eventType, setEventType] = useState<EventItem['eventType']>(initial?.eventType ?? 'other');
  const [dueLocal, setDueLocal] = useState(
    initial ? isoToDatetimeLocal(initial.dueAt, initial.timezone) : ''
  );
  const [timezone, setTimezone] = useState(initial?.timezone ?? browserTimezone());
  const [reminders, setReminders] = useState<ReminderDraft[]>(
    initial?.reminders?.length
      ? initial.reminders.map(({ offsetSeconds, channel }) => ({ offsetSeconds, channel }))
      : defaultReminders
  );
  const [busy, setBusy] = useState(false);
  const SubmitIcon = submitLabel.toLowerCase().includes('save') ? Save : CalendarPlus;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dueLocal) return;
    setBusy(true);
    try {
      await onSubmit({
        title,
        description: description || null,
        eventType,
        dueAt: datetimeLocalToIso(dueLocal, timezone),
        timezone,
        reminders: reminders.map(({ offsetSeconds, channel }) => ({ offsetSeconds, channel }))
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="neu-card space-y-5 p-6 animate-fade-up">
      <div>
        <label htmlFor="ef-title" className="label">
          Title
        </label>
        <input
          id="ef-title"
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="DBMS midterm"
          className="neu-input"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ef-type" className="label">
            Type
          </label>
          <select
            id="ef-type"
            value={eventType}
            onChange={(e) => setEventType(e.target.value as EventItem['eventType'])}
            className="neu-input"
          >
            <option value="exam">Exam</option>
            <option value="submission">Submission</option>
            <option value="hackathon">Hackathon</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label htmlFor="ef-due" className="label">
            Due (in selected timezone)
          </label>
          <input
            id="ef-due"
            required
            type="datetime-local"
            value={dueLocal}
            onChange={(e) => setDueLocal(e.target.value)}
            className="neu-input"
          />
        </div>
      </div>

      <div>
        <label htmlFor="ef-notes" className="label">
          Notes (optional)
        </label>
        <textarea
          id="ef-notes"
          rows={2}
          maxLength={2000}
          value={description ?? ''}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Chapters 1–6, closed notes…"
          className="neu-input resize-none"
        />
      </div>

      <div>
        <label htmlFor="ef-tz" className="label">
          Timezone
        </label>
        <input id="ef-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} className="neu-input" />
        <p className="mt-1 text-xs text-ink-soft">
          IANA identifier. The stored instant stays exact regardless of where you travel.
        </p>
      </div>

      <div>
        <span className="label">Reminders</span>
        <ReminderConfig value={reminders} onChange={setReminders} />
      </div>

      <button type="submit" disabled={busy} className="btn-primary min-h-[44px] w-full sm:w-auto" aria-busy={busy}>
        <SubmitIcon className="h-4 w-4" aria-hidden /> {busy ? 'Working…' : submitLabel}
      </button>
    </form>
  );
}

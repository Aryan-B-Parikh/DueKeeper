'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CalendarPlus, ClipboardPaste, ImageIcon, FileUp, PencilLine, Sparkles } from 'lucide-react';
import { calendarApi, eventsApi, extractApi, type EventItem, type ExtractCandidate } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { browserTimezone } from '@/lib/utils';
import { defaultReminders } from '@/components/ReminderConfig';
import { EventForm } from '@/components/EventForm';
import { ExtractionPreview } from '@/components/ExtractionPreview';
import { useToast } from '@/components/Toast';
import { cn } from '@/lib/utils';

type Tab = 'manual' | 'paste' | 'screenshot' | 'ics';

const TABS: Array<{ key: Tab; label: string; icon: typeof PencilLine }> = [
  { key: 'manual', label: 'Manual', icon: PencilLine },
  { key: 'paste', label: 'Paste text', icon: ClipboardPaste },
  { key: 'screenshot', label: 'Screenshot', icon: ImageIcon },
  { key: 'ics', label: 'Import .ics', icon: FileUp }
];

export default function NewEventPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('manual');
  const [pastedText, setPastedText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [candidates, setCandidates] = useState<{ engine: string; items: ExtractCandidate[] } | null>(null);

  async function createEvent(input: Parameters<React.ComponentProps<typeof EventForm>['onSubmit']>[0]) {
    try {
      await eventsApi.create(input);
      toast('success', `Deadline "${input.title}" created`);
      router.push('/dashboard');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not create deadline');
    }
  }

  async function runExtract(payload: () => Promise<{ engine: string; candidates: ExtractCandidate[] }>) {
    setExtracting(true);
    try {
      const result = await payload();
      if (result.candidates.length === 0) {
        toast('info', 'No deadlines detected. Try adding more context or create one manually.');
        return;
      }
      setCandidates({ engine: result.engine, items: result.candidates });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Extraction failed');
    } finally {
      setExtracting(false);
    }
  }

  async function confirmCandidates(selected: ExtractCandidate[]) {
    const source =
      candidates?.engine === 'gemini' && tab === 'screenshot' ? ('ai_screenshot' as const) : ('ai_text' as const);
    await extractApi.confirm(
      selected.map((c) => ({
        title: c.title,
        eventType: c.eventType,
        dueAt: c.dueAt!,
        timezone: c.timezone
      })),
      source
    );
    toast('success', `${selected.length} deadline(s) saved`);
    router.push('/dashboard');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Add a deadline</h1>
        <p className="text-sm text-ink-soft">
          Type it in, paste messy text, drop a screenshot, or import a calendar file.
        </p>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => {
              setTab(key);
              setCandidates(null);
            }}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition',
              tab === key
                ? 'bg-accent-soft text-accent shadow-neu-inset'
                : 'bg-surface text-ink-soft shadow-neu-sm hover:text-ink'
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'manual' && (
        <div className="animate-fade-up">
          <EventForm submitLabel="Create deadline" onSubmit={createEvent} />
        </div>
      )}

      {(tab === 'paste' || tab === 'screenshot') && !candidates && (
        <div className="neu-card space-y-5 p-6 animate-fade-up">
          {tab === 'paste' ? (
            <>
              <div>
                <span className="label">Paste any text mentioning deadlines</span>
                <textarea
                  rows={7}
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  placeholder={'e.g.\nFinal project submission is on Sep 15 at 11:59 PM\nHackathon registration closes tomorrow 5pm\nMath exam on 21/08/2026 10:30 AM'}
                  className="neu-input resize-none font-mono text-xs"
                />
              </div>
              <button
                disabled={extracting || pastedText.trim().length < 8}
                onClick={() =>
                  runExtract(() => extractApi.fromText(pastedText, user?.timezone ?? browserTimezone()))
                }
                className="btn-primary"
              >
                <Sparkles className="h-4 w-4" /> {extracting ? 'Extracting…' : 'Extract deadlines'}
              </button>
            </>
          ) : (
            <>
              <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-line p-10 text-center transition hover:border-accent/50">
                <ImageIcon className="h-8 w-8 text-ink-soft" />
                <span className="text-sm font-medium">Click to choose a PNG / JPEG / WebP screenshot</span>
                <span className="text-xs text-ink-soft">Max 10MB — timetables, LMS pages, email screenshots…</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  disabled={extracting}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void runExtract(() =>
                      extractApi.fromScreenshot(file, user?.timezone ?? browserTimezone())
                    );
                    e.target.value = '';
                  }}
                />
              </label>
              {extracting && <p className="text-sm text-accent">Reading the screenshot…</p>}
            </>
          )}
        </div>
      )}

      {candidates && (
        <div className="animate-fade-up">
          <ExtractionPreview
            candidates={candidates.items}
            engine={candidates.engine}
            onConfirm={confirmCandidates}
            onCancel={() => setCandidates(null)}
          />
        </div>
      )}

      {tab === 'ics' && <IcsImportCard onDone={() => router.push('/dashboard/calendar')} />}
    </div>
  );
}

function IcsImportCard({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  return (
    <div className="neu-card p-6 animate-fade-up">
      <h2 className="font-semibold">Import an iCalendar file</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Works with Google Calendar, Outlook and Apple Calendar exports (.ics). Duplicates are skipped by event UID.
      </p>
      <label className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-line p-10 text-center transition hover:border-accent/50">
        <FileUp className="h-8 w-8 text-ink-soft" />
        <span className="text-sm font-medium">{busy ? 'Importing…' : 'Click to choose your .ics file'}</span>
        <input
          type="file"
          accept=".ics,text/calendar"
          className="hidden"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy(true);
            try {
              const result = await calendarApi.importIcs(file);
              toast('success', `Imported ${result.imported}, skipped ${result.skipped}`);
              onDone();
            } catch (err) {
              toast('error', err instanceof Error ? err.message : 'Import failed');
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { AlertTriangle, Sparkles, Trash2 } from 'lucide-react';
import type { ExtractCandidate, EventType } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ExtractionPreviewProps {
  candidates: ExtractCandidate[];
  engine: string;
  onConfirm: (selected: ExtractCandidate[]) => Promise<void>;
  onCancel: () => void;
}

export function ExtractionPreview({ candidates, engine, onConfirm, onCancel }: ExtractionPreviewProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(candidates.filter((c) => c.confidence >= 0.7).map((c) => c.id))
  );
  const [edits, setEdits] = useState<Record<string, Partial<ExtractCandidate>>>({});
  const [saving, setSaving] = useState(false);

  function edit(id: string, patch: Partial<ExtractCandidate>) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function resolve(candidate: ExtractCandidate): ExtractCandidate {
    return { ...candidate, ...edits[candidate.id] };
  }

  const selected = candidates.filter((c) => selectedIds.has(c.id)).map(resolve);

  async function confirm() {
    setSaving(true);
    try {
      await onConfirm(selected);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent">
        <Sparkles className="h-4 w-4 shrink-0" />
        Found {candidates.length} candidate{candidates.length === 1 ? '' : 's'} via{' '}
        <strong>{engine === 'gemini' ? 'Gemini AI' : 'built-in parser'}</strong>. Detected: Title / Date / Time / Timezone / Confidence — review, edit and confirm.
      </div>

      {candidates.map((raw) => {
        const candidate = resolve(raw);
        const isSelected = selectedIds.has(raw.id);
        const lowConfidence = candidate.confidence < 0.7;
        return (
          <div key={raw.id} className={cn('neu-card p-4', !isSelected && 'opacity-60', lowConfidence && isSelected && 'ring-1 ring-warn/30')}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() =>
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(raw.id)) next.delete(raw.id);
                      else next.add(raw.id);
                      return next;
                    })
                  }
                  className="h-4 w-4 accent-[rgb(var(--accent))]"
                />
                Include
              </label>
              <div className="flex items-center gap-2">
                <span className="chip bg-surface text-xs">{candidate.timezone || 'UTC'}</span>
                <ConfidenceBadge confidence={candidate.confidence} />
                <button
                  onClick={() =>
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      next.delete(raw.id);
                      return next;
                    })
                  }
                  className="text-ink-soft transition hover:text-danger"
                  aria-label="Remove candidate"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <span className="label">Title</span>
                <input
                  value={candidate.title}
                  onChange={(e) => edit(raw.id, { title: e.target.value })}
                  className="neu-input"
                />
              </div>
              <div>
                <span className="label">Type</span>
                <select
                  value={candidate.eventType}
                  onChange={(e) => edit(raw.id, { eventType: e.target.value as EventType })}
                  className="neu-input"
                >
                  <option value="exam">Exam</option>
                  <option value="submission">Submission</option>
                  <option value="hackathon">Hackathon</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <span className="label">Due (UTC)</span>
                <input
                  type="text"
                  value={candidate.dueAt ?? ''}
                  placeholder="2026-09-15T18:29:00.000Z"
                  onChange={(e) => edit(raw.id, { dueAt: e.target.value || null })}
                  className="neu-input font-mono text-xs"
                />
              </div>
            </div>

            {(candidate.needsClarification || lowConfidence) && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-warn">
                <AlertTriangle className="h-3.5 w-3.5" /> {lowConfidence ? `Low confidence (${Math.round(candidate.confidence*100)}%) — we won’t auto-save below 70%. Please verify.` : 'Low certainty — double-check the date/time above.'}
              </p>
            )}
            {lowConfidence && isSelected && (
              <p className="mt-1 text-[11px] text-ink-soft">You’re including a low-confidence item — please edit title/date/timezone before confirming.</p>
            )}
          </div>
        );
      })}

      <div className="flex gap-3">
        <button onClick={confirm} disabled={saving || selected.length === 0} className="btn-primary flex-1">
          {saving ? 'Saving…' : `Add ${selected.length} deadline${selected.length === 1 ? '' : 's'}`}
        </button>
        <button onClick={onCancel} className="btn-ghost" disabled={saving}>
          Discard
        </button>
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const tone =
    pct >= 75
      ? 'bg-success/15 text-success'
      : pct >= 50
        ? 'bg-warn/15 text-warn'
        : 'bg-danger/15 text-danger';
  return <span className={`chip ${tone}`}>{pct}% sure</span>;
}

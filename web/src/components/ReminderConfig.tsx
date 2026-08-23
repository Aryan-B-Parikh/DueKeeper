'use client';

import { BellRing, Mail, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ReminderDraft {
  offsetSeconds: number;
  channel: 'email' | 'in_app';
}

const PRESETS: Array<{ label: string; seconds: number }> = [
  { label: '7d', seconds: 7 * 86400 },
  { label: '3d', seconds: 3 * 86400 },
  { label: '1d', seconds: 86400 },
  { label: '2h', seconds: 2 * 3600 },
  { label: '30m', seconds: 30 * 60 }
];

interface ReminderConfigProps {
  value: ReminderDraft[];
  onChange: (next: ReminderDraft[]) => void;
}

export function ReminderConfig({ value, onChange }: ReminderConfigProps) {
  function togglePreset(seconds: number) {
    const existing = value.find((r) => r.offsetSeconds === seconds && r.channel === 'in_app');
    if (existing) {
      onChange(value.filter((r) => r !== existing));
    } else {
      onChange([...value, { offsetSeconds: seconds, channel: 'in_app' }]);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map(({ label, seconds }) => {
          const active = value.some((r) => r.offsetSeconds === seconds && r.channel === 'in_app');
          return (
            <button
              key={label}
              type="button"
              onClick={() => togglePreset(seconds)}
              className={cn(
                'rounded-xl px-3.5 py-2 text-sm font-semibold transition',
                active
                  ? 'bg-accent-soft text-accent shadow-neu-inset'
                  : 'bg-surface text-ink-soft shadow-neu-sm hover:text-ink'
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-xs text-ink-soft">
        <Bell className="h-3.5 w-3.5" />
        In-app reminders selected above are always delivered; email reminders additionally require SMTP setup.
        <Mail className="h-3.5 w-3.5" />
      </div>
      {value.length > 0 && (
        <p className="text-xs text-ink-soft">
          <BellRing className="mr-1 inline h-3 w-3" />
          {value.length} reminder{value.length > 1 ? 's' : ''} will fire before the deadline.
        </p>
      )}
    </div>
  );
}

export const defaultReminders: ReminderDraft[] = [
  { offsetSeconds: 7 * 86400, channel: 'in_app' },
  { offsetSeconds: 86400, channel: 'in_app' },
  { offsetSeconds: 2 * 3600, channel: 'in_app' }
];

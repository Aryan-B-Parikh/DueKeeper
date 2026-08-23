import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function formatDueRelative(dueAtIso: string): string {
  const diff = new Date(dueAtIso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);

  let label: string;
  if (minutes < 1) label = 'now';
  else if (minutes < 60) label = `${minutes}m`;
  else if (hours < 48) label = `${hours}h`;
  else label = `${days}d`;

  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

export function formatDueFull(dueAtIso: string, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(new Date(dueAtIso));
  } catch {
    return new Date(dueAtIso).toUTCString();
  }
}

export function localDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export function zonedDateKey(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

const TYPE_META: Record<string, { icon: string; label: string }> = {
  exam: { icon: 'exam', label: 'Exam' },
  submission: { icon: 'submission', label: 'Submission' },
  hackathon: { icon: 'hackathon', label: 'Hackathon' },
  other: { icon: 'other', label: 'Other' }
};

export function typeMeta(type: string): { icon: string; label: string } {
  return TYPE_META[type] ?? TYPE_META.other;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export function isoToDatetimeLocal(iso: string, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date(iso));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}T${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`;
  } catch {
    return iso.slice(0, 16);
  }
}

export function datetimeLocalToIso(localValue: string, timezone: string): string {
  const [datePart, timePart = '00:00'] = localValue.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const naive = Date.UTC(y, mo - 1, d, h, mi);
    let offsetMin = 0;
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      const parts = dtf.formatToParts(new Date(naive));
      const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
      const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
      offsetMin = Math.round((asUtc - naive) / 60_000);
    } catch {
      offsetMin = 0;
    }
    if (attempt === 0) {
      const firstPass = naive - offsetMin * 60_000;
      const checkOffset = (() => {
        try {
          const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
          const parts = dtf.formatToParts(new Date(firstPass));
          const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
          const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
          return Math.round((asUtc - firstPass) / 60_000);
        } catch {
          return offsetMin;
        }
      })();
      if (checkOffset === offsetMin) {
        return new Date(firstPass).toISOString();
      }
    }
  }
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    const parts = dtf.formatToParts(new Date(naive));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return new Date(naive - Math.round((asUtc - naive) / 60_000) * 60_000).toISOString();
  } catch {
    return new Date(naive).toISOString();
  }
}

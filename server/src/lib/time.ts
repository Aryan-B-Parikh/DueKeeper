export const DUE_SOON_WINDOW_MS = 72 * 60 * 60 * 1000;
export const PLANNER_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REMINDER_OFFSET_S = 7 * 24 * 60 * 60;

export type EventStatus = 'upcoming' | 'due_soon' | 'overdue' | 'done' | 'cancelled';

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export function computeStatus(dueAtIso: string, storedStatus: string): EventStatus {
  if (storedStatus === 'done' || storedStatus === 'cancelled') {
    return storedStatus as EventStatus;
  }
  const diff = new Date(dueAtIso).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff <= DUE_SOON_WINDOW_MS) return 'due_soon';
  return 'upcoming';
}

const DURATION_UNITS: Record<string, number> = { m: 60, h: 3600, d: 86400 };

export function parseDurationSuffix(input: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(input.trim().toLowerCase());
  if (!match) return null;
  const unit = DURATION_UNITS[match[2]];
  if (unit === undefined) return null;
  return Number(match[1]) * unit;
}

export function formatOffsetLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d before`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h before`;
  return `${Math.round(seconds / 60)}m before`;
}

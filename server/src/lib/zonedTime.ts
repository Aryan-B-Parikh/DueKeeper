/**
 * Zone-aware time primitives.
 *
 * These live in `lib` rather than inside the extraction module because four
 * unrelated call sites need them — heuristic date parsing, ICS import/export,
 * Google Calendar sync, and request validation — and every copy of this logic
 * that was written locally got a DST case wrong. There is one implementation.
 */

/**
 * The wall-clock reading of `when` in `timezone`, expressed as the epoch ms of
 * that same clock reading interpreted as UTC.
 *
 * This is the primitive both the offset calculation and the round-trip check
 * below are built from: `wallClockAsUtcMs(tz, d) - d.getTime()` is the zone's
 * offset at that instant, and comparing it against a requested wall time tells
 * us whether a conversion actually landed on the time that was asked for.
 */
function wallClockAsUtcMs(timezone: string, when: Date): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const parts = dtf.formatToParts(when);
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    // `hour` comes back as 24 for midnight under some ICU versions with hour12:false.
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  } catch {
    return null;
  }
}

export function tzOffsetMinutes(timezone: string, when: Date): number | null {
  const asUtc = wallClockAsUtcMs(timezone, when);
  if (asUtc === null) return null;
  return Math.round((asUtc - when.getTime()) / 60_000);
}

export interface ZonedConversion {
  iso: string;
  /**
   * True when the requested wall time does not exist in the zone — a
   * spring-forward gap, e.g. 02:30 on 2026-03-08 in America/New_York, where the
   * clock jumps 02:00 -> 03:00. The result is the first real instant at or
   * after the requested one (02:30 becomes 03:30), never an earlier time.
   */
  adjusted: boolean;
}

/**
 * Converts a wall-clock time in `timezone` to a UTC instant.
 *
 * Two passes are required because the offset to apply depends on the very
 * instant being computed: sampling the offset at "naive interpreted as UTC" is
 * an hour off within a day of a DST transition (H5). The second pass re-samples
 * at the candidate instant and converges.
 *
 * Two passes are still not always enough, and that is what the round-trip check
 * catches. During a spring-forward gap the requested wall time never occurs, so
 * no offset reproduces it and the iteration oscillates. Rather than silently
 * return an instant an hour away from what the caller asked for, the gap is
 * detected and reported via `adjusted`.
 *
 * Ambiguous times (the repeated hour at fall-back) resolve to the first, i.e.
 * still-in-DST, occurrence. That is the earlier instant, which for a deadline
 * product is the safe direction: a reminder fires early rather than late.
 */
export function zonedToUtc(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
  second = 0
): ZonedConversion | null {
  const naive = Date.UTC(year, monthIndex, day, hour, minute, second);
  if (!Number.isFinite(naive)) return null;

  const firstOffset = tzOffsetMinutes(timezone, new Date(naive));
  if (firstOffset === null) return null;

  let offset = firstOffset;
  let candidate = naive - offset * 60_000;
  const secondOffset = tzOffsetMinutes(timezone, new Date(candidate));
  if (secondOffset !== null && secondOffset !== offset) {
    offset = secondOffset;
    candidate = naive - offset * 60_000;
  }

  // Round-trip: read the candidate back in the zone. If the wall clock there is
  // not the wall clock we were asked for, the requested time does not exist.
  const roundTrip = wallClockAsUtcMs(timezone, new Date(candidate));
  if (roundTrip === null) return null;
  if (roundTrip !== naive) {
    // Apply the pre-transition (larger, i.e. further-behind-UTC) offset. That
    // pushes the result past the gap instead of before it, so the instant is
    // always >= what the caller intended.
    const preTransition = Math.min(firstOffset, secondOffset ?? firstOffset);
    const shifted = naive - preTransition * 60_000;
    return { iso: new Date(shifted).toISOString(), adjusted: true };
  }

  return { iso: new Date(candidate).toISOString(), adjusted: false };
}

export function zonedToUtcIso(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
  second = 0
): string | null {
  return zonedToUtc(year, monthIndex, day, hour, minute, timezone, second)?.iso ?? null;
}

/**
 * A date on a calendar, with no instant and no zone attached.
 *
 * Relative-date parsing ("tomorrow", "next Friday") has to happen on the user's
 * calendar, not the server's. Passing a `Date` around for this invites reading
 * it back with `getMonth()`/`getDay()`, which silently re-interprets it in the
 * server's zone — a one-day error for any user far enough east or west. Keeping
 * the civil date as plain numbers makes that mistake impossible to write.
 */
export interface CivilDate {
  year: number;
  /** 0-based, matching Date's month convention. */
  month: number;
  day: number;
  /** 0 = Sunday, matching Date's getDay convention. */
  weekday: number;
}

function civilFromUtcMs(ms: number): CivilDate {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    weekday: d.getUTCDay()
  };
}

/** Today's date on the calendar of `timezone`. */
export function civilDateInZone(timezone: string, when: Date = new Date()): CivilDate {
  const asUtc = wallClockAsUtcMs(timezone, when);
  if (asUtc === null) {
    // Unknown zone: fall back to the UTC calendar rather than the server's, so
    // the result is at least deterministic across deployments.
    return civilFromUtcMs(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
  }
  const civil = civilFromUtcMs(asUtc);
  return civilFromUtcMs(Date.UTC(civil.year, civil.month, civil.day));
}

/** Calendar-day arithmetic: no offsets, no DST, so month/year rollover is exact. */
export function addCivilDays(base: CivilDate, days: number): CivilDate {
  return civilFromUtcMs(Date.UTC(base.year, base.month, base.day + days));
}

/** True if year/monthIndex/day is a real calendar date (rejects Feb 31, month 99). */
export function isValidCivilDate(year: number, monthIndex: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || !Number.isInteger(day)) return false;
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, monthIndex, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === monthIndex && probe.getUTCDate() === day
  );
}

export function localDateKey(iso: string, timezone: string): string {
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

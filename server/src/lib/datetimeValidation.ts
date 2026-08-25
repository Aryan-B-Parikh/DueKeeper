import { z } from 'zod';
import { isValidCivilDate } from '../modules/extract/dateUtils';

/**
 * Timezone and instant validation shared by every write path (events, extract
 * confirm, calendar import), so a deadline cannot enter the database through one
 * door under weaker rules than another.
 */

// Rough shape gate before the expensive Intl construction, and a hard bound on
// length so a hostile value cannot push work into ICU.
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

const tzCache = new Map<string, boolean>();

export function isValidTimezone(tz: string): boolean {
  if (tz === 'UTC') return true;
  if (tz.length > 64 || !IANA_SHAPE.test(tz)) return false;
  const cached = tzCache.get(tz);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    // Intl accepts fixed offsets like "+05:30" and, in some engines, aliases we
    // would rather not store. Requiring a region/city form (or UTC) keeps the
    // column to real IANA zone ids, which is what DST calculations need.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = tz.includes('/');
  } catch {
    ok = false;
  }
  // Bound the cache: it is keyed by attacker-supplied strings, but only ones
  // that already passed the shape test and ICU lookup, so the space is small.
  if (tzCache.size < 1000) tzCache.set(tz, ok);
  return ok;
}

/**
 * ISO 8601 with a mandatory UTC designator or numeric offset.
 *
 * The offset is not optional by oversight — it is the whole point. ECMAScript
 * parses a date-time with no offset as *local to whatever machine runs the
 * parse*, so `2026-03-14T09:00:00` meant one thing on the client and another on
 * the server, and the user's real zone sat unread in the `timezone` column
 * (H5). Requiring the offset makes the instant unambiguous at the boundary.
 */
const OFFSET_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

export interface InstantProblem {
  code: 'FORMAT' | 'OFFSET' | 'CALENDAR' | 'RANGE';
  message: string;
}

// Reject instants far enough out that they are certainly data errors, and that
// would otherwise sit in the scheduler's horizon queries forever.
const MIN_INSTANT_MS = Date.UTC(1970, 0, 1);
const MAX_INSTANT_MS = Date.UTC(2200, 0, 1);

export function validateInstant(value: string): InstantProblem | null {
  const match = OFFSET_DATETIME.exec(value.trim());
  if (!match) {
    if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2})?/.test(value.trim())) {
      return {
        code: 'OFFSET',
        message:
          'dueAt must include a UTC designator or offset, e.g. 2026-08-24T15:00:00Z or 2026-08-24T15:00:00+05:30'
      };
    }
    return { code: 'FORMAT', message: 'dueAt must be an ISO 8601 date-time' };
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;

  // Date.parse rolls impossible dates over silently: "2026-02-31" becomes
  // March 3rd rather than an error.
  if (!isValidCivilDate(year, month, day)) {
    return { code: 'CALENDAR', message: 'dueAt is not a real calendar date' };
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return { code: 'CALENDAR', message: 'dueAt has an out-of-range time component' };
  }

  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) {
    return { code: 'FORMAT', message: 'dueAt must be an ISO 8601 date-time' };
  }
  if (ms < MIN_INSTANT_MS || ms > MAX_INSTANT_MS) {
    return { code: 'RANGE', message: 'dueAt must fall between 1970 and 2200' };
  }
  return null;
}

/** Normalizes an already-validated instant to canonical UTC ISO form. */
export function toUtcIso(value: string): string {
  return new Date(value.trim()).toISOString();
}

export const timezoneSchema = z
  .string()
  .trim()
  .min(1, 'timezone is required')
  .max(64)
  .refine(isValidTimezone, 'timezone must be an IANA identifier such as Asia/Kolkata or UTC');

export const instantSchema = z
  .string()
  .trim()
  .min(1, 'dueAt is required')
  .superRefine((value, ctx) => {
    const problem = validateInstant(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem.message });
  })
  .transform(toUtcIso);

import { isValidCivilDate, addCivilDays, zonedToUtcIso } from './zonedTime';
import { isValidTimezone } from './datetimeValidation';

/**
 * A minimal RFC 5545 reader/writer.
 *
 * Two properties matter more than completeness here. First, nothing a remote
 * calendar file says may crash the import or escape into the exported file —
 * every value is bounded, and every date is validated rather than handed to
 * `new Date()` and hoped over. Second, a wall-clock time in a calendar has to be
 * resolved through the same DST-correct primitive the rest of the server uses;
 * the local copy this replaced sampled the zone offset at the wrong instant and
 * was an hour off within a day of a transition.
 */
export interface IcsEvent {
  uid: string;
  title: string;
  description?: string;
  /** DTSTART resolved to a UTC instant. */
  startUtcIso: string;
  /** DTEND resolved to a UTC instant, when the file supplied one. */
  endUtcIso?: string;
  /** True when DTSTART is a DATE rather than a DATE-TIME. */
  allDay: boolean;
  /** All-day only: the first calendar day, `YYYY-MM-DD`. */
  startDate?: string;
  /**
   * All-day only: the *inclusive* last calendar day, `YYYY-MM-DD`.
   *
   * DTEND is exclusive for DATE values (RFC 5545 §3.8.2.2), so a single-day
   * event on the 10th carries `DTEND;VALUE=DATE:20260311`. Reporting the raw
   * DTEND would put every all-day deadline a day late.
   */
  lastDate?: string;
  /** True when the event carries an RRULE; only the first occurrence is parsed. */
  recurring: boolean;
}

export interface IcsParseOptions {
  /**
   * Zone for "floating" times — a DATE-TIME with neither a `Z` suffix nor a
   * TZID. RFC 5545 §3.3.5 defines those as local time wherever the calendar is
   * being read, so the observer's zone is the correct reading. Interpreting them
   * as UTC (the previous behaviour) shifted every such deadline by the user's
   * offset. Also used when a TZID names a zone this platform does not know,
   * which is common with Outlook's Windows zone names.
   */
  defaultTimezone?: string;
  maxEvents?: number;
}

const MAX_INPUT_CHARS = 4 * 1024 * 1024;
const MAX_LINES = 200_000;
const DEFAULT_MAX_EVENTS = 1000;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_UID_CHARS = 255;

/**
 * Strips the control characters RFC 5545 forbids in property values.
 *
 * Tab, line feed and carriage return survive on purpose: the escaper needs to
 * see line breaks in order to turn them into `\n` sequences, and tab is a legal
 * VALUE-CHAR.
 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function unfoldLines(raw: string): string[] {
  const bounded = raw.length > MAX_INPUT_CHARS ? raw.slice(0, MAX_INPUT_CHARS) : raw;
  const normalized = bounded.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n', MAX_LINES);
  const unfolded: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/**
 * Splits `NAME;PARAM=VALUE:value` at the colon that ends the property name.
 *
 * A quoted parameter value may itself contain a colon (`ALTREP="cid:x"`), so the
 * first colon in the line is not necessarily the separator.
 */
function splitProperty(line: string): { name: string; params: string; value: string } | null {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) {
      if (i === 0) return null;
      const left = line.slice(0, i);
      const semi = left.indexOf(';');
      return {
        name: (semi === -1 ? left : left.slice(0, semi)).trim().toUpperCase(),
        params: semi === -1 ? '' : left.slice(semi + 1),
        value: line.slice(i + 1)
      };
    }
  }
  return null;
}

function paramValue(params: string, key: string): string | null {
  const match = new RegExp(`(?:^|;)${key}=([^;]*)`, 'i').exec(params);
  if (!match) return null;
  return match[1].trim().replace(/^"(.*)"$/, '$1');
}

interface ParsedIcsDate {
  iso: string;
  dateOnly: boolean;
  year: number;
  /** 0-based. */
  month: number;
  day: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function civilToDateString(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month + 1)}-${pad(day)}`;
}

/**
 * Resolves an ICS DATE or DATE-TIME value to a UTC instant.
 *
 * Returns null rather than a guess for anything malformed: an unparseable
 * DTSTART means the event is skipped, which is far better than importing a
 * deadline on a date nobody wrote down.
 */
function parseIcsDate(value: string, params: string, defaultTimezone: string): ParsedIcsDate | null {
  const raw = value.trim();
  const isUtc = /Z$/i.test(raw);
  const compact = raw.replace(/[-:]/g, '').replace(/Z$/i, '');

  const dateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(compact);
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]) - 1;
    const day = Number(dateMatch[3]);
    if (!isValidCivilDate(year, month, day)) return null;
    // The nominal instant is midnight UTC. Callers that care (the importer)
    // localize `startDate` instead; this keeps the field non-optional.
    return { iso: new Date(Date.UTC(year, month, day)).toISOString(), dateOnly: true, year, month, day };
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(compact);
  if (!dateTime) return null;

  const year = Number(dateTime[1]);
  const month = Number(dateTime[2]) - 1;
  const day = Number(dateTime[3]);
  const hour = Number(dateTime[4]);
  const minute = Number(dateTime[5]);
  // A leap second (:60) is legal in the grammar and has no JS representation.
  const second = Math.min(Number(dateTime[6]), 59);
  if (!isValidCivilDate(year, month, day)) return null;
  if (hour > 23 || minute > 59) return null;

  if (isUtc) {
    return {
      iso: new Date(Date.UTC(year, month, day, hour, minute, second)).toISOString(),
      dateOnly: false,
      year,
      month,
      day
    };
  }

  const tzid = paramValue(params, 'TZID');
  // An unknown TZID (Outlook writes "Eastern Standard Time") and a floating time
  // are the same situation: no usable zone in the file, so use the observer's.
  const zone = tzid && isValidTimezone(tzid) ? tzid : defaultTimezone;
  const iso =
    zonedToUtcIso(year, month, day, hour, minute, zone, second) ??
    new Date(Date.UTC(year, month, day, hour, minute, second)).toISOString();
  return { iso, dateOnly: false, year, month, day };
}

/**
 * Reverses RFC 5545 text escaping in a single pass.
 *
 * Chained replaces cannot do this correctly: replacing `\n` before `\\` turns
 * the two-character sequence `\\n` (an escaped backslash followed by a literal
 * "n") into a newline.
 */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nNrt:"])/g, (_match, ch: string) => {
    if (ch === 'n' || ch === 'N') return '\n';
    if (ch === 'r') return '\n';
    if (ch === 't') return '\t';
    return ch;
  });
}

interface PendingEvent {
  uid?: string;
  title?: string;
  description?: string;
  start?: ParsedIcsDate;
  end?: ParsedIcsDate;
  recurring: boolean;
}

export function parseIcsCalendar(raw: string, options: IcsParseOptions = {}): IcsEvent[] {
  const defaultTimezone =
    options.defaultTimezone && isValidTimezone(options.defaultTimezone) ? options.defaultTimezone : 'UTC';
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;

  const events: IcsEvent[] = [];
  // Component nesting has to be tracked: a VALARM inside a VEVENT has its own
  // SUMMARY and DESCRIPTION, and a flat parser lets the alarm's text overwrite
  // the event's.
  const stack: string[] = [];
  let current: PendingEvent | null = null;

  for (const line of unfoldLines(raw)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('BEGIN:')) {
      const component = upper.slice(6).trim();
      stack.push(component);
      if (component === 'VEVENT' && current === null) {
        current = { recurring: false };
      }
      continue;
    }

    if (upper.startsWith('END:')) {
      const component = upper.slice(4).trim();
      if (component === 'VEVENT' && current) {
        const finished = finalizeEvent(current, events.length);
        if (finished) events.push(finished);
        current = null;
        if (events.length >= maxEvents) break;
      }
      if (stack[stack.length - 1] === component) stack.pop();
      continue;
    }

    // Only VEVENT-level properties are read; anything inside a nested component
    // (VALARM, and in a VCALENDAR-level sense VTIMEZONE) is ignored.
    if (!current || stack[stack.length - 1] !== 'VEVENT') continue;

    const property = splitProperty(trimmed);
    if (!property) continue;
    const { name, params, value } = property;

    if (name === 'UID') {
      current.uid = stripControlChars(value.trim()).slice(0, MAX_UID_CHARS);
    } else if (name === 'SUMMARY') {
      current.title = stripControlChars(unescapeText(value)).trim().slice(0, MAX_TITLE_CHARS);
    } else if (name === 'DESCRIPTION') {
      current.description = stripControlChars(unescapeText(value)).trim().slice(0, MAX_DESCRIPTION_CHARS);
    } else if (name === 'DTSTART') {
      current.start = parseIcsDate(value, params, defaultTimezone) ?? undefined;
    } else if (name === 'DTEND') {
      current.end = parseIcsDate(value, params, defaultTimezone) ?? undefined;
    } else if (name === 'RRULE') {
      current.recurring = true;
    }
  }

  return events;
}

function finalizeEvent(pending: PendingEvent, index: number): IcsEvent | null {
  // DTEND without DTSTART is malformed, but the intent is unambiguous enough to
  // salvage: the event happens at the only time given.
  const start = pending.start ?? pending.end;
  if (!start || !pending.title) return null;

  const event: IcsEvent = {
    uid: pending.uid || `ics-${index}-${start.iso}`,
    title: pending.title,
    description: pending.description,
    startUtcIso: start.iso,
    endUtcIso: pending.end && pending.end !== start ? pending.end.iso : undefined,
    allDay: start.dateOnly,
    recurring: pending.recurring
  };

  if (start.dateOnly) {
    event.startDate = civilToDateString(start.year, start.month, start.day);
    const end = pending.end;
    if (end?.dateOnly && Date.UTC(end.year, end.month, end.day) > Date.UTC(start.year, start.month, start.day)) {
      const inclusive = addCivilDays({ year: end.year, month: end.month, day: end.day, weekday: 0 }, -1);
      event.lastDate = civilToDateString(inclusive.year, inclusive.month, inclusive.day);
    } else {
      event.lastDate = event.startDate;
    }
  }

  return event;
}

/**
 * Escapes a value for an ICS property.
 *
 * The backslash has to be doubled first, or the escapes introduced afterwards
 * get escaped in turn. A bare `\r` must also be folded into `\n`: leaving it raw
 * lets a title containing a carriage return terminate the line in lenient
 * parsers and inject arbitrary properties into the exported calendar.
 */
function escapeText(value: string): string {
  return stripControlChars(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds a content line to RFC 5545's 75-octet limit.
 *
 * The limit is octets of UTF-8, not characters, and §3.1 forbids splitting a
 * multi-octet sequence. Slicing by UTF-16 code units did both wrong: a line of
 * CJK titles overran the limit threefold, and a cut landing inside a surrogate
 * pair (any emoji) emitted a lone surrogate, which is not valid UTF-8 at all.
 */
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;

  const out: string[] = [];
  let chunk = '';
  let bytes = 0;
  let limit = 75;
  // Iterating the string yields whole code points, so a surrogate pair is never
  // split; grapheme clusters may still be, which the spec permits.
  for (const char of line) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > limit) {
      out.push(chunk);
      chunk = '';
      bytes = 0;
      // Continuation lines carry a leading space that counts toward the limit.
      limit = 74;
    }
    chunk += char;
    bytes += charBytes;
  }
  if (chunk !== '') out.push(chunk);

  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n');
}

/** Formats an instant as an RFC 5545 UTC DATE-TIME, or null if unusable. */
function toIcsDateTime(iso: string): string | null {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  // Always Zulu: a value carrying an offset like +05:30 is not valid ICS, and
  // emitting one silently produced a calendar other clients refused to open.
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function generateIcsCalendar(
  events: Array<{ id: string; title: string; dueAt: string; description?: string | null }>
): string {
  const stamp = toIcsDateTime(new Date().toISOString())!;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DueKeeper//Deadlines//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH'
  ];

  for (const event of events) {
    const dtstart = toIcsDateTime(event.dueAt);
    // A row with an unusable due date is skipped rather than allowed to throw:
    // one bad row must not take down the whole export.
    if (!dtstart) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(event.id)}@duekeeper`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${dtstart}`,
      `SUMMARY:${escapeText(event.title)}`
    );
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

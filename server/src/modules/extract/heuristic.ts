import { addDays, zonedToUtcIso } from './dateUtils';

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6
};

const KEYWORD_RE =
  /(deadline|due|submit|submission|exam|test|quiz|midterm|finals?|hackathon|assignment|homework|report|presentation|interview|milestone)/i;

export interface HeuristicCandidate {
  title: string;
  eventType: 'exam' | 'submission' | 'hackathon' | 'other';
  dueAtIso: string | null;
  confidence: number;
  needsClarification: boolean;
  matchedText: string;
}

export function parseTimeOfDay(text: string): { hour: number; minute: number } | null {
  const lowered = text.toLowerCase();
  if (/\b(noon|midday)\b/.test(lowered)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(lowered)) return { hour: 0, minute: 0 };
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/.exec(lowered);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2] ? Number(ampm[2]) : 0;
    if (ampm[3].startsWith('p') && hour < 12) hour += 12;
    if (ampm[3].startsWith('a') && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  const plain = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(lowered);
  if (plain) return { hour: Number(plain[1]), minute: Number(plain[2]) };
  if (/\bmorning\b/.test(lowered)) return { hour: 9, minute: 0 };
  if (/\bafternoon\b/.test(lowered)) return { hour: 14, minute: 0 };
  if (/\bevening\b/.test(lowered)) return { hour: 19, minute: 0 };
  if (/\bnight\b/.test(lowered)) return { hour: 21, minute: 0 };
  return null;
}

interface DateResolution {
  year: number;
  month: number;
  day: number;
  explicitYear: boolean;
  explicitTime: boolean;
}

function rollYear(currentYear: number, month: number, day: number): number {
  const candidate = new Date(currentYear, month, day, 23, 59);
  return candidate.getTime() < Date.now() ? currentYear + 1 : currentYear;
}

function resolveDate(segment: string, today: Date): DateResolution | null {
  const time = parseTimeOfDay(segment);

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(segment);
  if (iso) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]) - 1,
      day: Number(iso[3]),
      explicitYear: true,
      explicitTime: Boolean(time)
    };
  }

  const monthName =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i.exec(
      segment
    );
  if (monthName) {
    const month = MONTHS[monthName[1].toLowerCase()];
    const day = Number(monthName[2]);
    if (month === undefined || day < 1 || day > 31) return null;
    const year = monthName[3]
      ? Number(monthName[3])
      : rollYear(today.getFullYear(), month, day);
    return { year, month, day, explicitYear: Boolean(monthName[3]), explicitTime: Boolean(time) };
  }

  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(segment);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    let year = numeric[3] ? Number(numeric[3]) : undefined;
    if (year !== undefined && year < 100) year += 2000;
    let day: number;
    let month: number;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else {
      day = a;
      month = b;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return {
      year: year ?? rollYear(today.getFullYear(), month - 1, day),
      month: month - 1,
      day,
      explicitYear: Boolean(numeric[3]),
      explicitTime: Boolean(time)
    };
  }

  const lowered = segment.toLowerCase();
  const inDays = /\bin\s+(\d{1,3})\s+(days?|weeks?)\b/.exec(lowered);
  let target: Date | null = null;
  if (inDays) {
    target = addDays(today, Number(inDays[1]) * (inDays[2].startsWith('week') ? 7 : 1));
  } else if (/\b(tomorrow|tmrw|tmr)\b/.test(lowered)) {
    target = addDays(today, 1);
  } else if (/\b(today|tonight)\b/.test(lowered)) {
    target = today;
  } else {
    const weekday =
      /\b(next\s+|on\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i.exec(
        segment
      );
    if (weekday) {
      const dow = WEEKDAYS[weekday[2].toLowerCase()];
      let delta = (dow - today.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      if (/^next/i.test(weekday[1] ?? '') && delta <= 2) delta += 7;
      target = addDays(today, delta);
    }
  }
  if (target) {
    return {
      year: target.getFullYear(),
      month: target.getMonth(),
      day: target.getDate(),
      explicitYear: false,
      explicitTime: Boolean(time)
    };
  }
  return null;
}

export function inferTitle(segment: string): string {
  const cleaned = segment.replace(/\s+/g, ' ').trim();
  const match = KEYWORD_RE.exec(cleaned);
  if (!match) {
    const words = cleaned.split(' ').slice(0, 8).join(' ');
    return words.length > 0 ? words.slice(0, 120) : 'Untitled deadline';
  }
  const before = cleaned.slice(0, match.index).trim().split(' ').filter(Boolean);
  const head = before.slice(-6).join(' ');
  const tailSource = cleaned.slice(match.index + match[0].length).trim();
  const tail = tailSource.split(/[,.;:\n]/)[0].trim().split(' ').slice(0, 4).join(' ');
  const keyword = match[0].toLowerCase();
  if (head.length >= 3 && tail.length >= 3) {
    return `${head} ${keyword} ${tail}`.slice(0, 140);
  }
  if (head.length >= 3) return `${head} ${keyword}`.slice(0, 140);
  if (tail.length >= 3) return `${keyword} ${tail}`.slice(0, 140);
  return keyword.slice(0, 140);
}

export function inferEventType(segment: string): HeuristicCandidate['eventType'] {
  const lower = segment.toLowerCase();
  if (/\b(exam|test|quiz|midterm|finals?)\b/.test(lower)) return 'exam';
  if (/\bhackathon\b/.test(lower)) return 'hackathon';
  if (/\b(submit|submission|assignment|homework|report)\b/.test(lower)) return 'submission';
  if (/\b(deadline|due|project deliverable|milestone)\b/.test(lower)) return 'submission';
  return 'other';
}

function toCandidate(segment: string, today: Date, timezone: string): HeuristicCandidate | null {
  if (!KEYWORD_RE.test(segment)) return null;
  const resolution = resolveDate(segment, today);
  if (!resolution) return null;

  const time = parseTimeOfDay(segment);
  const iso = zonedToUtcIso(
    resolution.year,
    resolution.month,
    resolution.day,
    time ? time.hour : 23,
    time ? time.minute : 59,
    timezone
  );
  if (!iso) return null;

  let confidence = 0.55;
  if (resolution.explicitYear) confidence += 0.15;
  if (time) confidence += 0.15;
  const keywordMatch = KEYWORD_RE.exec(segment);
  if (keywordMatch && keywordMatch.index < 40) confidence += 0.05;
  if (!time) confidence -= 0.05;
  confidence = Math.min(0.95, Math.max(0.3, confidence));

  return {
    title: capitalize(inferTitle(segment)),
    eventType: inferEventType(segment),
    dueAtIso: iso,
    confidence: Number(confidence.toFixed(2)),
    needsClarification: !time || !resolution.explicitYear,
    matchedText: segment.replace(/\s+/g, ' ').trim().slice(0, 200)
  };
}

function capitalize(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

export function extractHeuristicCandidates(text: string, timezone: string): HeuristicCandidate[] {
  const today = new Date();
  const segments = text
    .split(/\r?\n|(?<=[.;!?])\s+|\s+[·•|]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);

  const seen = new Set<string>();
  const candidates: HeuristicCandidate[] = [];
  for (const segment of segments) {
    const candidate = toCandidate(segment, today, timezone);
    if (!candidate) continue;
    const dedupeKey = `${candidate.title.toLowerCase()}|${candidate.dueAtIso}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push(candidate);
    if (candidates.length >= 20) break;
  }
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

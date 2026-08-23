export interface IcsEvent {
  uid: string;
  title: string;
  description?: string;
  startUtcIso: string;
  endUtcIso?: string;
  allDay: boolean;
}

function unfoldLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
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

function parseIcsDate(value: string, params: string): string | null {
  const isUtc = value.endsWith('Z');
  const compact = value.replace(/[-:]/g, '').replace('Z', '');
  const dateOnly = /^\d{8}$/.test(compact);
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(compact);

  if (dateOnly) {
    const year = Number(compact.slice(0, 4));
    const month = Number(compact.slice(4, 6));
    const day = Number(compact.slice(6, 8));
    return new Date(Date.UTC(year, month - 1, day, 0, 0)).toISOString();
  }
  if (!dateTime) return null;

  const [, y, mo, d, h, mi, s] = dateTime.map(Number) as unknown as number[];
  const tzidMatch = /TZID=([^;]+)/.exec(params);
  const utcMs = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  if (isUtc || !tzidMatch) return new Date(utcMs).toISOString();

  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzidMatch[1],
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    const offsetMin = Math.round((asUtc - utcMs) / 60_000);
    return new Date(utcMs - offsetMin * 60_000).toISOString();
  } catch {
    return new Date(utcMs).toISOString();
  }
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

export function parseIcsCalendar(raw: string): IcsEvent[] {
  const lines = unfoldLines(raw);
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> & { rawStart?: { value: string; params: string } } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase() === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (trimmed.toUpperCase() === 'END:VEVENT') {
      if (current?.rawStart && current.title) {
        const startIso = parseIcsDate(current.rawStart.value, current.rawStart.params);
        if (startIso) {
          events.push({
            uid: current.uid ?? `ics-${events.length}-${startIso}`,
            title: current.title.slice(0, 200),
            description: current.description,
            startUtcIso: startIso,
            allDay: /^\d{8}$/.test(current.rawStart.value.replace(/[-:]/g, '').replace('Z', ''))
          });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const left = trimmed.slice(0, colon);
    const value = trimmed.slice(colon + 1);
    const semi = left.indexOf(';');
    const name = (semi === -1 ? left : left.slice(0, semi)).toUpperCase();
    const params = semi === -1 ? '' : left.slice(semi + 1);

    if (name === 'UID') current.uid = value.trim();
    else if (name === 'SUMMARY') current.title = unescapeText(value).trim();
    else if (name === 'DESCRIPTION') current.description = unescapeText(value).trim().slice(0, 2000);
    else if (name === 'DTSTART') current.rawStart = { value: value.trim(), params };
    else if (name === 'DTEND' && !current.rawStart) current.rawStart = { value: value.trim(), params };
  }
  return events;
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function foldLine(line: string): string {
  if (line.length <= 73) return line;
  const chunks: string[] = [];
  let rest = line;
  chunks.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length > 0) {
    chunks.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  return chunks.join('\r\n');
}

function toIcsDateTime(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function generateIcsCalendar(
  events: Array<{ id: string; title: string; dueAt: string; description?: string | null }>
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DueKeeper//Deadlines//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH'
  ];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.id}@duekeeper`,
      `DTSTAMP:${toIcsDateTime(new Date().toISOString())}`,
      `DTSTART:${toIcsDateTime(event.dueAt)}`,
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

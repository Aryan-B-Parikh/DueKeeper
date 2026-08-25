import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcsCalendar, generateIcsCalendar } from '../lib/ics';

const SAMPLE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:event-001@external',
  'DTSTAMP:20260801T000000Z',
  'DTSTART;TZID=Asia/Kolkata:20260902T093000',
  'SUMMARY:Tz aware event with\\, comma',
  'DESCRIPTION:line one\\nline two',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:event-002@external',
  'DTSTART:20260910T140000Z',
  'SUMMARY:Utc event',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

describe('ics parsing', () => {
  it('parses UTC and TZID start times to UTC instants', () => {
    const events = parseIcsCalendar(SAMPLE);
    assert.equal(events.length, 2);
    assert.equal(events[1].startUtcIso, '2026-09-10T14:00:00.000Z');
    assert.equal(events[0].startUtcIso, '2026-09-02T04:00:00.000Z');
    assert.equal(events[0].uid, 'event-001@external');
    assert.equal(events[0].title, 'Tz aware event with, comma');
    assert.ok(events[0].description?.includes('\n'));
  });

  it('unfolds folded lines', () => {
    const folded = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:folded@x',
      'DTSTART:20260901T100000Z',
      'SUMMARY:a very long summary that was fol',
      ' ded across physical lines',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
    const events = parseIcsCalendar(folded);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'a very long summary that was folded across physical lines');
  });

  it('round-trips through the generator', () => {
    const events = parseIcsCalendar(SAMPLE);
    const generated = generateIcsCalendar(
      events.map((e) => ({ id: e.uid, title: e.title, dueAt: e.startUtcIso }))
    );
    const reparsed = parseIcsCalendar(generated);
    assert.equal(reparsed.length, 2);
    assert.deepEqual(
      reparsed.map((e) => [e.title, e.startUtcIso]).sort(),
      events.map((e) => [e.title, e.startUtcIso]).sort()
    );
  });

  it('returns empty for non-calendar input', () => {
    assert.equal(parseIcsCalendar('not a calendar at all').length, 0);
  });
});

describe('ics hardening', () => {
  function calendar(...vevent: string[]): string {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevent, 'END:VCALENDAR'].join('\r\n');
  }

  it('reads a floating time in the observer zone, not UTC', () => {
    // No Z and no TZID: RFC 5545 calls this a floating time, local to whoever
    // reads the calendar. Reading it as UTC shifted every such deadline by the
    // user's offset — 5.5 hours for the default profile zone here.
    const ics = calendar(
      'BEGIN:VEVENT',
      'UID:floating@x',
      'DTSTART:20260902T093000',
      'SUMMARY:Floating',
      'END:VEVENT'
    );
    assert.equal(
      parseIcsCalendar(ics, { defaultTimezone: 'Asia/Kolkata' })[0].startUtcIso,
      '2026-09-02T04:00:00.000Z'
    );
    assert.equal(parseIcsCalendar(ics)[0].startUtcIso, '2026-09-02T09:30:00.000Z');
  });

  it('falls back to the observer zone for a TZID the platform cannot resolve', () => {
    // Outlook writes Windows zone names, which ICU does not accept.
    const ics = calendar(
      'BEGIN:VEVENT',
      'UID:outlook@x',
      'DTSTART;TZID=Eastern Standard Time:20260902T093000',
      'SUMMARY:Outlook style',
      'END:VEVENT'
    );
    assert.equal(
      parseIcsCalendar(ics, { defaultTimezone: 'Asia/Kolkata' })[0].startUtcIso,
      '2026-09-02T04:00:00.000Z'
    );
  });

  it('applies the DST-correct offset for a TZID on a transition day', () => {
    // 2026-03-08 09:30 in New York is EDT (UTC-4). The single-pass offset sample
    // this parser used to do read EST and answered an hour late.
    const ics = calendar(
      'BEGIN:VEVENT',
      'UID:dst@x',
      'DTSTART;TZID=America/New_York:20260308T093000',
      'SUMMARY:Spring forward',
      'END:VEVENT'
    );
    assert.equal(parseIcsCalendar(ics)[0].startUtcIso, '2026-03-08T13:30:00.000Z');
  });

  it('accepts a quoted TZID and a colon inside a quoted parameter', () => {
    const ics = calendar(
      'BEGIN:VEVENT',
      'UID:quoted@x',
      'DTSTART;TZID="America/New_York":20260115T080000',
      'SUMMARY;ALTREP="cid:part1@x":Quoted params',
      'END:VEVENT'
    );
    const [event] = parseIcsCalendar(ics);
    assert.equal(event.startUtcIso, '2026-01-15T13:00:00.000Z');
    assert.equal(event.title, 'Quoted params');
  });

  it('treats DTEND as exclusive for all-day events', () => {
    // A single-day all-day event on the 10th is written DTEND:20260311.
    const ics = calendar(
      'BEGIN:VEVENT',
      'UID:allday@x',
      'DTSTART;VALUE=DATE:20260310',
      'DTEND;VALUE=DATE:20260313',
      'SUMMARY:Hack week',
      'END:VEVENT'
    );
    const [event] = parseIcsCalendar(ics);
    assert.equal(event.allDay, true);
    assert.equal(event.startDate, '2026-03-10');
    assert.equal(event.lastDate, '2026-03-12', 'DTEND is exclusive, so the last day is the 12th');
  });

  it('does not let a VALARM overwrite the event summary', () => {
    const ics = calendar(
      'BEGIN:VEVENT',
      'UID:alarm@x',
      'DTSTART:20260901T100000Z',
      'SUMMARY:Real event title',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'SUMMARY:Reminder popup text',
      'DESCRIPTION:popup body',
      'END:VALARM',
      'END:VEVENT'
    );
    const [event] = parseIcsCalendar(ics);
    assert.equal(event.title, 'Real event title');
    assert.equal(event.description, undefined);
  });

  it('skips impossible dates instead of rolling them forward', () => {
    const ics = calendar(
      'BEGIN:VEVENT',
      'UID:bad@x',
      'DTSTART:20260231T100000Z',
      'SUMMARY:February 31st',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:good@x',
      'DTSTART:20260228T100000Z',
      'SUMMARY:February 28th',
      'END:VEVENT'
    );
    const events = parseIcsCalendar(ics);
    assert.equal(events.length, 1);
    assert.equal(events[0].uid, 'good@x');
  });

  it('unescapes an escaped backslash without inventing a newline', () => {
    // Chained replaces turned the two characters \\ followed by n into a line
    // break. A single pass keeps them a backslash and the letter n.
    const ics = calendar(
      'BEGIN:VEVENT',
      'UID:esc@x',
      'DTSTART:20260901T100000Z',
      'SUMMARY:path C:\\\\next',
      'END:VEVENT'
    );
    assert.equal(parseIcsCalendar(ics)[0].title, 'path C:\\next');
  });

  it('honours the event cap', () => {
    const vevents: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      vevents.push('BEGIN:VEVENT', `UID:e${i}@x`, 'DTSTART:20260901T100000Z', `SUMMARY:Event ${i}`, 'END:VEVENT');
    }
    assert.equal(parseIcsCalendar(calendar(...vevents), { maxEvents: 4 }).length, 4);
  });
});

describe('ics generation', () => {
  it('escapes a carriage return so a title cannot inject a property', () => {
    const generated = generateIcsCalendar([
      { id: 'x', title: 'Evil\rDTSTART:19700101T000000Z', dueAt: '2026-09-01T10:00:00.000Z' }
    ]);
    assert.ok(!/\r\nDTSTART:19700101/.test(generated), 'injected property must not appear');
    assert.ok(generated.includes('SUMMARY:Evil\\nDTSTART:19700101T000000Z'));
    // And the calendar still parses to exactly one event at the real time.
    const [event] = parseIcsCalendar(generated);
    assert.equal(event.startUtcIso, '2026-09-01T10:00:00.000Z');
  });

  it('folds to 75 octets without splitting a multi-byte character', () => {
    const title = '締切'.repeat(40);
    const generated = generateIcsCalendar([
      { id: 'y', title, dueAt: '2026-09-01T10:00:00.000Z' }
    ]);
    for (const line of generated.split('\r\n')) {
      assert.ok(
        Buffer.byteLength(line, 'utf8') <= 75,
        `line exceeds 75 octets: ${Buffer.byteLength(line, 'utf8')}`
      );
    }
    // Round-tripping proves nothing was corrupted at a fold boundary.
    assert.equal(parseIcsCalendar(generated)[0].title, title.slice(0, 200));
  });

  it('never emits a lone surrogate when folding emoji', () => {
    const title = '🎯'.repeat(30);
    const generated = generateIcsCalendar([{ id: 'z', title, dueAt: '2026-09-01T10:00:00.000Z' }]);
    // A lone surrogate survives a Buffer round-trip as U+FFFD.
    assert.ok(!Buffer.from(generated, 'utf8').toString('utf8').includes('\uFFFD'));
    assert.equal(parseIcsCalendar(generated)[0].title, title);
  });

  it('skips a row with an unusable due date instead of throwing', () => {
    const generated = generateIcsCalendar([
      { id: 'bad', title: 'Broken', dueAt: 'not-a-date' },
      { id: 'ok', title: 'Fine', dueAt: '2026-09-01T10:00:00.000Z' }
    ]);
    const events = parseIcsCalendar(generated);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Fine');
  });

  it('emits Zulu times for an offset-bearing input', () => {
    const generated = generateIcsCalendar([
      { id: 'o', title: 'Offset input', dueAt: '2026-09-01T15:30:00+05:30' }
    ]);
    assert.ok(generated.includes('DTSTART:20260901T100000Z'));
  });
});

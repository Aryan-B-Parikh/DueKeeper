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

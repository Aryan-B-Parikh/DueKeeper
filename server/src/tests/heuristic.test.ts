import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractHeuristicCandidates, parseTimeOfDay } from '../modules/extract/heuristic';

describe('time-of-day parsing', () => {
  it('parses am/pm variants', () => {
    assert.deepEqual(parseTimeOfDay('11:59 PM'), { hour: 23, minute: 59 });
    assert.deepEqual(parseTimeOfDay('9am'), { hour: 9, minute: 0 });
    assert.deepEqual(parseTimeOfDay('12:30 a.m.'), { hour: 0, minute: 30 });
    assert.deepEqual(parseTimeOfDay('5 p.m. sharp'), { hour: 17, minute: 0 });
  });

  it('parses word times', () => {
    assert.deepEqual(parseTimeOfDay('by noon'), { hour: 12, minute: 0 });
    assert.deepEqual(parseTimeOfDay('at midnight'), { hour: 0, minute: 0 });
    assert.deepEqual(parseTimeOfDay('tomorrow evening'), { hour: 19, minute: 0 });
  });

  it('parses 24h clock', () => {
    assert.deepEqual(parseTimeOfDay('due 14:45'), { hour: 14, minute: 45 });
  });
});

describe('heuristic extraction', () => {
  it('extracts ISO dates with explicit time', () => {
    const out = extractHeuristicCandidates('Project deadline is 2026-11-20 at 18:00', 'UTC');
    assert.equal(out.length, 1);
    assert.equal(out[0].dueAtIso, '2026-11-20T18:00:00.000Z');
    assert.equal(out[0].eventType, 'submission');
    assert.ok(out[0].confidence >= 0.7);
  });

  it('defaults to 23:59 and flags clarification when no time given', () => {
    const out = extractHeuristicCandidates('Exam on December 3', 'UTC');
    assert.equal(out.length, 1);
    assert.match(out[0].dueAtIso ?? '', /T23:59:00\.000Z$/);
    assert.equal(out[0].needsClarification, true);
    assert.equal(out[0].eventType, 'exam');
  });

  it('rolls unambiguous month-day forward to next year when past', () => {
    const now = new Date();
    const pastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    if (now.getMonth() > 0) {
      const text = `Final report due ${monthNames[pastMonth.getMonth()]} 15`;
      const out = extractHeuristicCandidates(text, 'UTC');
      assert.equal(out.length, 1);
      assert.ok((out[0].dueAtIso ?? '').startsWith(String(now.getFullYear() + 1)));
    }
  });

  it('converts naive local time through the timezone', () => {
    const out = extractHeuristicCandidates('Quiz submission due Jan 10 2027 08:30', 'Asia/Kolkata');
    assert.equal(out.length, 1);
    assert.equal(out[0].dueAtIso, '2027-01-10T03:00:00.000Z');
  });

  it('handles dd/mm over mm/dd when unambiguous', () => {
    const out = extractHeuristicCandidates('Hackathon submission deadline 25/12/2026', 'UTC');
    assert.equal(out.length, 1);
    assert.equal(out[0].dueAtIso, '2026-12-25T23:59:00.000Z');
    assert.equal(out[0].eventType, 'hackathon');
  });

  it('ignores segments without deadline keywords', () => {
    const out = extractHeuristicCandidates('Team meeting moved to Friday 3pm and lunch tomorrow', 'UTC');
    assert.equal(out.length, 0);
  });

  it('finds multiple independent deadlines in one blob', () => {
    const text = [
      'Math exam on Mar 5 2027 at 09:00 AM',
      'Essay submission is due Apr 1 2027 23:59',
      'Hackathon starts Jun 10 2027'
    ].join('\n');
    const out = extractHeuristicCandidates(text, 'UTC');
    assert.equal(out.length, 3);
  });
});

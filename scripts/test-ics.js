'use strict';

// ICS parser checks: folded lines, all-day, TZID across a DST boundary,
// WEEKLY RRULE with EXDATE + override, CANCELLED skipped, window bounds.

const { parseICS } = require('../lib/ics');

const FIXTURE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'X-WR-CALNAME:test',
  // 1: plain event with a folded summary line
  'BEGIN:VEVENT',
  'UID:plain-1@test',
  'DTSTART:20261010T140000Z',
  'DTEND:20261010T150000Z',
  'SUMMARY:CS 3510 review sess',
  ' ion in Klaus',
  'END:VEVENT',
  // 2: all-day event
  'BEGIN:VEVENT',
  'UID:allday-1@test',
  'DTSTART;VALUE=DATE:20261015',
  'DTEND;VALUE=DATE:20261016',
  'SUMMARY:Fall break',
  'END:VEVENT',
  // 3: weekly TZID event spanning the Nov 1 2026 DST end, Tue/Thu,
  //    with one EXDATE and one overridden occurrence
  'BEGIN:VEVENT',
  'UID:recur-1@test',
  'DTSTART;TZID=America/New_York:20261020T100000',
  'DTEND;TZID=America/New_York:20261020T111500',
  'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261120T050000Z',
  'EXDATE;TZID=America/New_York:20261029T100000',
  'SUMMARY:MATH 3235 lecture',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:recur-1@test',
  'RECURRENCE-ID;TZID=America/New_York:20261027T100000',
  'DTSTART;TZID=America/New_York:20261027T140000',
  'DTEND;TZID=America/New_York:20261027T151500',
  'SUMMARY:MATH 3235 lecture (moved)',
  'END:VEVENT',
  // 4: cancelled event
  'BEGIN:VEVENT',
  'UID:cancelled-1@test',
  'DTSTART:20261012T170000Z',
  'STATUS:CANCELLED',
  'SUMMARY:cancelled thing',
  'END:VEVENT',
  // 5: event outside the window
  'BEGIN:VEVENT',
  'UID:old-1@test',
  'DTSTART:20240101T120000Z',
  'SUMMARY:ancient event',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const windowStart = Date.UTC(2026, 9, 1);
const windowEnd = Date.UTC(2026, 11, 1);
const { events, unsupported } = parseICS(FIXTURE, { windowStart, windowEnd });

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL ${msg}`); };
const okLog = (msg) => console.log(`ok   ${msg}`);

// folded line
const plain = events.find((e) => e.uid === 'plain-1@test');
if (!plain) fail('plain event missing');
else if (plain.title !== 'CS 3510 review session in Klaus') fail(`folded summary: "${plain.title}"`);
else okLog('folded summary unfolds');

// all-day
const allday = events.find((e) => e.uid === 'allday-1@test');
if (!allday || !allday.allDay) fail('all-day flag');
else okLog('all-day event');

// recurring TZID series
const recur = events.filter((e) => e.uid === 'recur-1@test').sort((a, b) => a.start - b.start);
// Expected: Oct 20, 22, (27 overridden), (29 EXDATE'd out), Nov 3, 5, 10, 12, 17, 19 — until Nov 20
const expectEDT = (d, h) => Date.UTC(2026, 9, d, h + 4); // EDT = UTC-4
const expectEST = (d, h) => Date.UTC(2026, 10, d, h + 5); // EST = UTC-5

if (recur.length !== 9) fail(`recurrence count: got ${recur.length}, expected 9 (${recur.map((e) => new Date(e.start).toISOString()).join(', ')})`);
else okLog('recurrence count (EXDATE honored, UNTIL honored)');

if (!recur.some((e) => e.start === expectEDT(20, 10))) fail('first occurrence Oct 20 10:00 EDT');
else okLog('first occurrence at 10:00 EDT');

const moved = recur.find((e) => e.title.includes('moved'));
if (!moved) fail('override occurrence missing');
else if (moved.start !== expectEDT(27, 14)) fail(`override time: ${new Date(moved.start).toISOString()}`);
else okLog('RECURRENCE-ID override applied');

if (recur.some((e) => e.start === expectEDT(29, 10))) fail('EXDATE occurrence still present');
else okLog('EXDATE removed Oct 29');

// DST: Nov 3 must be 10:00 EST (15:00 UTC), not 14:00 UTC
if (!recur.some((e) => e.start === expectEST(3, 10))) fail(`DST shift: Nov 3 not at 10:00 EST (have ${recur.map((e) => new Date(e.start).toISOString()).join(', ')})`);
else okLog('DST boundary: wall clock held at 10:00 across Nov 1');

// stable per-occurrence ids
const ids = new Set(recur.map((e) => e.sourceId));
if (ids.size !== recur.length) fail('occurrence sourceIds not unique');
else okLog('occurrence sourceIds unique');

// cancelled + window
if (events.some((e) => e.uid === 'cancelled-1@test')) fail('cancelled event ingested');
else okLog('cancelled skipped');
if (events.some((e) => e.uid === 'old-1@test')) fail('out-of-window event ingested');
else okLog('window bounds respected');

if (unsupported.length) fail(`unexpected unsupported: ${unsupported.join(',')}`);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall ics tests passed');

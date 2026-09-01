'use strict';

// Google Calendar via the calendar's private ICS address. Read-only, no OAuth.
// Google refreshes these feeds lazily (up to hours) — fine for events.

const { parseICS } = require('../ics');

const WINDOW_BACK_MS = 7 * 24 * 3600 * 1000;
const WINDOW_FWD_MS = 90 * 24 * 3600 * 1000;

/**
 * ctx: { icsUrl }
 * → { courses: [], items, notes }
 */
async function fetchAll(ctx) {
  if (!ctx.icsUrl) throw new Error('no calendar ICS URL');

  const res = await fetch(ctx.icsUrl, {
    headers: { 'User-Agent': 'school-tracker' },
    signal: AbortSignal.timeout(60000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`calendar feed HTTP ${res.status}`);
  const text = await res.text();

  // A revoked/mistyped secret address serves a Google HTML error page.
  if (!/^\s*BEGIN:VCALENDAR/.test(text)) {
    throw new Error('that URL did not return a calendar — re-copy the "Secret address in iCal format" from Google Calendar settings');
  }

  const now = Date.now();
  const { events, unsupported } = parseICS(text, {
    windowStart: now - WINDOW_BACK_MS,
    windowEnd: now + WINDOW_FWD_MS,
  });

  const items = events.map((ev) => ({
    source: 'gcal',
    source_id: ev.sourceId,
    courseKey: null,
    kind: 'event',
    title: ev.title,
    url: null,
    due_at: ev.start,
    all_day: ev.allDay,
    raw: { location: ev.location, description: ev.description, end: ev.end },
  }));

  const notes = unsupported.length
    ? [`${unsupported.length} recurring event(s) use an unsupported repeat rule (only the base date was ingested)`]
    : [];

  return { courses: [], items, notes };
}

module.exports = { id: 'gcal', label: 'Google Calendar', fetchAll };

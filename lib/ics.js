'use strict';

// Hand-rolled ICS parser for Google Calendar's private feed. Covers what a
// student calendar actually contains: plain events, all-day events, TZID
// times, and WEEKLY/DAILY recurrences (classes, office hours). Anything more
// exotic is reported in `unsupported` rather than silently guessed at.

/** Wall-clock in an IANA timezone → epoch ms, via a two-pass Intl correction. */
function zonedEpoch(y, mo, d, h, mi, s, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const want = guess;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
      }).formatToParts(new Date(guess)).map((p) => [p.type, p.value])
    );
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
    );
    const diff = want - asUtc;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

function unfold(text) {
  return String(text).replace(/\r?\n[ \t]/g, '');
}

/** "DTSTART;TZID=America/New_York:20260901T140000" → { name, params, value } */
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

const unescapeText = (v) =>
  String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

/**
 * One DATE or DATE-TIME value → { epoch, allDay, wall } where `wall` keeps the
 * wall-clock pieces so recurrence expansion can re-anchor each occurrence in
 * its own timezone (DST-correct).
 */
function parseIcsTime(value, params = {}) {
  const v = String(value).trim();

  if ((params.VALUE === 'DATE') || /^\d{8}$/.test(v)) {
    const y = +v.slice(0, 4), mo = +v.slice(4, 6), d = +v.slice(6, 8);
    return {
      epoch: new Date(y, mo - 1, d).getTime(), // local midnight
      allDay: true,
      wall: { y, mo, d, h: 0, mi: 0, s: 0, tz: null, utc: false },
    };
  }

  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const wall = { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +s, tz: params.TZID || null, utc: z === 'Z' };
  return { epoch: wallToEpoch(wall), allDay: false, wall };
}

function wallToEpoch(w) {
  if (w.utc) return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (w.tz) return zonedEpoch(w.y, w.mo, w.d, w.h, w.mi, w.s, w.tz);
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime(); // floating → local
}

/** Advance a wall-clock date by n calendar days (UTC-noon math dodges DST). */
function addDays(w, n) {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n, 12));
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const dowOf = (w) => new Date(Date.UTC(w.y, w.mo - 1, w.d, 12)).getUTCDay();
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(value) {
  const rule = {};
  for (const part of String(value).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return rule;
}

const MAX_OCCURRENCES = 500;

/**
 * Expand WEEKLY/DAILY rules from DTSTART over [windowStart, windowEnd].
 * Returns { occurrences: [{epoch, wall}], supported }.
 */
function expandRRule(rule, startWall, windowStart, windowEnd) {
  const freq = rule.FREQ;
  if (freq !== 'WEEKLY' && freq !== 'DAILY') return { occurrences: [], supported: false };

  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  let until = null;
  if (rule.UNTIL) {
    const u = parseIcsTime(rule.UNTIL, /^\d{8}$/.test(rule.UNTIL) ? { VALUE: 'DATE' } : {});
    if (u) until = u.allDay ? u.epoch + 24 * 3600 * 1000 - 1 : u.epoch;
  }

  const days = freq === 'WEEKLY'
    ? (rule.BYDAY
        ? rule.BYDAY.split(',').map((t) => BYDAY[t.trim().slice(-2)]).filter((n) => n !== undefined)
        : [dowOf(startWall)])
    : null;

  // Week-index anchor so INTERVAL=2 skips alternate weeks relative to DTSTART.
  const startDayNum = Math.floor(Date.UTC(startWall.y, startWall.mo - 1, startWall.d, 12) / 86400000);
  const startWeek = Math.floor((startDayNum - 4) / 7); // 1970-01-01 was a Thursday; -4 anchors Monday

  const occurrences = [];
  let made = 0;
  let cursor = { ...startWall };

  for (let step = 0; step < 5000 && made < MAX_OCCURRENCES; step++) {
    const w = addDays(startWall, step);
    if (freq === 'DAILY' && step % interval !== 0) continue;
    if (freq === 'WEEKLY') {
      if (!days.includes(dowOf(w))) continue;
      const dayNum = Math.floor(Date.UTC(w.y, w.mo - 1, w.d, 12) / 86400000);
      const week = Math.floor((dayNum - 4) / 7);
      if ((week - startWeek) % interval !== 0) continue;
    }

    const epoch = wallToEpoch(w);
    if (epoch < wallToEpoch(startWall)) continue;
    if (until !== null && epoch > until) break;
    made++;
    if (count !== null && made > count) break;
    if (epoch > windowEnd) break;
    if (epoch >= windowStart) occurrences.push({ epoch, wall: w });
    cursor = w;
  }

  return { occurrences, supported: true };
}

/**
 * Parse a full ICS document. Returns:
 *   { events: [{ sourceId, uid, title, description, location, start, end, allDay }],
 *     unsupported: [uid...] }
 * Recurring events are expanded within the window; every occurrence gets
 * sourceId = `${uid}@${epoch}` so re-syncs stay stable.
 */
function parseICS(text, { windowStart, windowEnd } = {}) {
  windowStart = windowStart ?? Date.now() - 7 * 24 * 3600 * 1000;
  windowEnd = windowEnd ?? Date.now() + 90 * 24 * 3600 * 1000;

  const lines = unfold(text).split(/\r?\n/);
  const vevents = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (current) vevents.push(current); current = null; continue; }
    if (!current) continue;

    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': current.uid = p.value.trim(); break;
      case 'SUMMARY': current.title = unescapeText(p.value); break;
      case 'DESCRIPTION': current.description = unescapeText(p.value).slice(0, 2000); break;
      case 'LOCATION': current.location = unescapeText(p.value); break;
      case 'STATUS': current.status = p.value.trim().toUpperCase(); break;
      case 'DTSTART': current.start = parseIcsTime(p.value, p.params); break;
      case 'DTEND': current.end = parseIcsTime(p.value, p.params); break;
      case 'RRULE': current.rrule = parseRRule(p.value); break;
      case 'RECURRENCE-ID': current.recurrenceId = parseIcsTime(p.value, p.params); break;
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const t = parseIcsTime(v, p.params);
          if (t) current.exdates.push(t.epoch);
        }
        break;
    }
  }

  // Overrides: a VEVENT with RECURRENCE-ID replaces that one occurrence.
  const overrides = new Map(); // uid → Map(epoch → vevent)
  for (const ev of vevents) {
    if (ev.uid && ev.recurrenceId) {
      if (!overrides.has(ev.uid)) overrides.set(ev.uid, new Map());
      overrides.get(ev.uid).set(ev.recurrenceId.epoch, ev);
    }
  }

  const events = [];
  const unsupported = [];
  const minute = (e) => Math.floor(e / 60000);

  const emit = (ev, epoch, wall) => {
    const durationMs = ev.end && ev.start ? Math.max(0, ev.end.epoch - ev.start.epoch) : 0;
    events.push({
      sourceId: ev.rrule ? `${ev.uid}@${epoch}` : ev.uid,
      uid: ev.uid,
      title: ev.title || '(untitled)',
      description: ev.description || '',
      location: ev.location || '',
      start: epoch,
      end: durationMs ? epoch + durationMs : null,
      allDay: !!(ev.start && ev.start.allDay),
    });
  };

  for (const ev of vevents) {
    if (!ev.uid || !ev.start) continue;
    if (ev.status === 'CANCELLED') continue;
    if (ev.recurrenceId) continue; // handled as an override below

    if (!ev.rrule) {
      if (ev.start.epoch >= windowStart && ev.start.epoch <= windowEnd) emit(ev, ev.start.epoch, ev.start.wall);
      continue;
    }

    const { occurrences, supported } = expandRRule(ev.rrule, ev.start.wall, windowStart, windowEnd);
    if (!supported) {
      unsupported.push(ev.uid);
      // Still show the base event if it happens to fall in the window.
      if (ev.start.epoch >= windowStart && ev.start.epoch <= windowEnd) emit(ev, ev.start.epoch, ev.start.wall);
      continue;
    }

    const ovr = overrides.get(ev.uid) || new Map();
    const exdates = new Set(ev.exdates.map(minute));
    for (const occ of occurrences) {
      if (exdates.has(minute(occ.epoch))) continue;
      const replacement = ovr.get(occ.epoch);
      if (replacement) {
        if (replacement.status === 'CANCELLED' || !replacement.start) continue;
        const merged = { ...ev, ...replacement, rrule: ev.rrule, uid: ev.uid };
        if (replacement.start.epoch >= windowStart && replacement.start.epoch <= windowEnd) {
          events.push({
            sourceId: `${ev.uid}@${occ.epoch}`,
            uid: ev.uid,
            title: merged.title || ev.title || '(untitled)',
            description: merged.description || '',
            location: merged.location || '',
            start: replacement.start.epoch,
            end: replacement.end ? replacement.end.epoch : null,
            allDay: !!replacement.start.allDay,
          });
        }
        continue;
      }
      emit(ev, occ.epoch, occ.wall);
    }
  }

  return { events, unsupported };
}

module.exports = { parseICS, parseIcsTime, zonedEpoch, expandRRule, parseRRule, unfold };

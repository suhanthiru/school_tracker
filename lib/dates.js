'use strict';

// Heuristic deadline extraction from free text ("quiz moved to Friday",
// "read ch 7 by 9/15 at 5pm"). Deliberately conservative: callers only trust
// a result when the text resolves to exactly ONE calendar day — anything
// ambiguous goes to the AI fallback (or stays undated).

const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, wed: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const RE_REL = /\b(today|tonight|tomorrow|tmrw|tmr)\b/gi;
const RE_WD = /\b(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)\b/gi;
const RE_MD = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/gi;
const RE_NUM = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;

const RE_TIME_12 = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/gi;
const RE_TIME_24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const RE_TIME_WORD = /\b(noon|midnight)\b/gi;

const DEADLINE_WORDS = /\b(due|deadline|dues?date|quiz|exam|midterm|final|test|submit|submission|homework|hw\b|pset|problem set|project|essay|paper|report|moved|postponed|extended|reschedul|push(?:ed)? back|now on)\b/i;

const hasDeadlineKeyword = (text) => DEADLINE_WORDS.test(String(text || ''));

const dayKey = (d) => `${d.y}-${d.m}-${d.d}`;

/** Every date-like phrase in the text, resolved to local calendar days. */
function findDates(text, now = Date.now()) {
  const s = String(text || '');
  const ref = new Date(now);
  const out = [];

  const push = (m, y, mo, d) => out.push({ y, m: mo, d, index: m.index, length: m[0].length, phrase: m[0] });

  for (const m of s.matchAll(RE_REL)) {
    const add = /^(today|tonight)$/i.test(m[1]) ? 0 : 1;
    const t = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + add);
    push(m, t.getFullYear(), t.getMonth(), t.getDate());
  }

  for (const m of s.matchAll(RE_WD)) {
    const target = WEEKDAYS[m[2].toLowerCase()];
    let days = (target - ref.getDay() + 7) % 7;
    if (days === 0 && (m[1] || '').toLowerCase() === 'next') days = 7;
    const t = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + days);
    push(m, t.getFullYear(), t.getMonth(), t.getDate());
  }

  for (const m of s.matchAll(RE_MD)) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const d = Number(m[2]);
    if (d < 1 || d > 31) continue;
    let y = m[3] ? Number(m[3]) : ref.getFullYear();
    // No year given and the date is far in the past — they mean next year.
    if (!m[3] && new Date(y, mo, d).getTime() < now - 45 * 24 * 3600 * 1000) y += 1;
    push(m, y, mo, d);
  }

  for (const m of s.matchAll(RE_NUM)) {
    const mo = Number(m[1]) - 1;
    const d = Number(m[2]);
    if (mo < 0 || mo > 11 || d < 1 || d > 31) continue;
    let y = m[3] ? Number(m[3]) : ref.getFullYear();
    if (y < 100) y += 2000;
    if (!m[3] && new Date(y, mo, d).getTime() < now - 45 * 24 * 3600 * 1000) y += 1;
    push(m, y, mo, d);
  }

  return out;
}

/** Times in the text, with the date phrases blanked out first so the "9" in
 *  "9/15" is never read as nine o'clock. */
function findTimes(text, dateMatches) {
  let s = String(text || '');
  for (const d of dateMatches) {
    s = s.slice(0, d.index) + ' '.repeat(d.length) + s.slice(d.index + d.length);
  }
  const out = [];

  for (const m of s.matchAll(RE_TIME_12)) {
    let h = Number(m[1]) % 12;
    if (/^p/i.test(m[3])) h += 12;
    out.push({ h, min: Number(m[2] || 0), index: m.index, length: m[0].length });
  }
  for (const m of s.matchAll(RE_TIME_24)) {
    // Skip anything the 12-hour pass already claimed (e.g. the "11:59" in "11:59pm").
    if (out.some((t) => m.index >= t.index && m.index < t.index + t.length)) continue;
    out.push({ h: Number(m[1]), min: Number(m[2]), index: m.index, length: m[0].length });
  }
  for (const m of s.matchAll(RE_TIME_WORD)) {
    out.push(m[1].toLowerCase() === 'noon'
      ? { h: 12, min: 0, index: m.index, length: m[0].length }
      : { h: 23, min: 59, index: m.index, length: m[0].length });
  }
  return out;
}

/**
 * The one deadline this text names, or null when it names zero or several.
 * Default time is 23:59 — the canonical academic deadline.
 */
function extractSingle(text, now = Date.now()) {
  const dates = findDates(text, now);
  if (!dates.length) return null;

  const days = new Set(dates.map(dayKey));
  if (days.size !== 1) return null;

  const times = findTimes(text, dates);
  const distinct = new Set(times.map((t) => `${t.h}:${t.min}`));
  const time = distinct.size === 1 ? times[0] : { h: 23, min: 59 };

  const { y, m, d } = dates[0];
  return new Date(y, m, d, time.h, time.min).getTime();
}

/**
 * Quick-capture parser: "read ch 7 by fri 5pm" → the task title with the date
 * phrasing stripped, plus the resolved due date (or null).
 */
function parseCapture(text, now = Date.now()) {
  const raw = String(text || '').trim();
  if (!raw) return { title: '', due_at: null };

  const dates = findDates(raw, now);
  if (!dates.length) return { title: raw, due_at: null };

  const date = dates[dates.length - 1];
  const times = findTimes(raw, dates);
  const time = times.length ? times[times.length - 1] : { h: 23, min: 59 };
  const due = new Date(date.y, date.m, date.d, time.h, time.min).getTime();

  // Strip the date/time phrases and any glue word directly before them.
  const spans = [ { index: date.index, length: date.length } ];
  if (times.length) spans.push({ index: times[times.length - 1].index, length: times[times.length - 1].length });
  spans.sort((a, b) => b.index - a.index);

  let title = raw;
  for (const span of spans) {
    title = title.slice(0, span.index) + title.slice(span.index + span.length);
  }
  title = title
    .replace(/\b(by|due|on|at|before|until)\s*$/i, '')
    .replace(/\b(by|due|on|at|before|until)\s+(by|due|on|at|before|until)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:—-]+$/g, '')
    .trim();

  // The glue word may sit mid-string now ("read ch 7 by  5pm" → "read ch 7 by").
  title = title.replace(/\s+\b(by|due|on|before|until)\b\s*$/i, '').trim();

  return { title: title || raw, due_at: due };
}

module.exports = { findDates, findTimes, extractSingle, parseCapture, hasDeadlineKeyword };

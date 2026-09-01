'use strict';

const db = require('./db');
const secrets = require('./secrets');
const ai = require('./ai');
const dates = require('./dates');
const notify = require('./notify');

const canvas = require('./sources/canvas');
const gcal = require('./sources/gcal');
const ed = require('./sources/ed');
const gradescope = require('./sources/gradescope');

function inElectron() {
  try { return !!require('electron').session; } catch { return false; }
}

// One entry per source; enabled() gates on configuration so an untouched
// source reports "skipped", never "error". One dead source must not hide the
// others, and a parser that matches suspiciously little must fail loudly —
// both lessons inherited from the internship tracker.
const SOURCES = [
  {
    ...canvas,
    // Token where the school allows one; otherwise the in-app Canvas SSO
    // session (GT blocks student-created tokens).
    enabled: () => secrets.hasSecret('canvas_token')
      || (inElectron() && db.getSetting('canvas_state') !== 'never'),
    ctx: () => ({
      baseUrl: db.getSetting('canvas_base_url'),
      token: secrets.getSecret('canvas_token'),
    }),
    stateKey: 'canvas_state',
  },
  {
    ...gcal,
    enabled: () => secrets.hasSecret('gcal_ics_url'),
    ctx: () => ({ icsUrl: secrets.getSecret('gcal_ics_url') }),
  },
  {
    ...ed,
    enabled: () => secrets.hasSecret('ed_token'),
    ctx: () => ({ baseUrl: db.getSetting('ed_base_url'), token: secrets.getSecret('ed_token') }),
  },
  {
    ...gradescope,
    enabled: () => inElectron() && db.getSetting('gradescope_state') !== 'never',
    ctx: () => ({}),
    stateKey: 'gradescope_state',
  },
];

let syncing = false;

/**
 * Pull every enabled source (or just `only`) and upsert. Each source reports
 * its own numbers so a feed that quietly stops matching shows up as "0" in the
 * health strip instead of disappearing without a trace.
 */
async function sync(only = null) {
  if (syncing) return readReport() || { skipped: true };
  syncing = true;

  const report = { at: Date.now(), added: 0, updated: 0, sources: [] };

  try {
    for (const source of SOURCES) {
      if (only && source.id !== only) continue;

      const health = {
        id: source.id, label: source.label,
        ok: false, skipped: false, matched: 0, added: 0, error: null, notes: [],
      };
      report.sources.push(health);

      if (!source.enabled()) { health.skipped = true; continue; }

      const roundStart = Date.now();
      const firstSync = !db.hasSyncedBefore(source.id);
      const inserted = [];
      let updated = 0;

      try {
        const { courses = [], items = [], notes = [] } = await source.fetchAll(source.ctx());
        health.notes = notes;

        const courseMap = new Map();
        for (const c of courses) courseMap.set(c.source_id, db.upsertCourse(c));

        for (const item of items) {
          const { document, courseKey, ...fields } = item;
          const { result, id } = db.upsertItem({
            ...fields,
            course_id: courseKey ? (courseMap.get(courseKey) ?? null) : null,
          });
          if (result === 'inserted') {
            inserted.push({ ...item, id });
            health.added++;
            report.added++;
          } else {
            updated++;
            report.updated++;
          }
        }

        db.markMissing(source.id, roundStart);
        health.ok = true;
        health.matched = items.length;

        if (source.stateKey && db.getSetting(source.stateKey) !== 'never') {
          db.setSetting(source.stateKey, 'ok');
        }
        if (source.id === 'ed') extractAnnouncementDates(inserted);
        if (!firstSync) notify.newItems(source.label, inserted);
      } catch (err) {
        health.error = String(err.message || err);
        if (err.expired && source.stateKey) {
          db.setSetting(source.stateKey, 'expired');
          notify.ssoExpired(source.label);
        }
      }

      db.logSync({
        at: roundStart, source: source.id, ok: health.ok,
        matched: health.matched, added: health.added, updated,
        error: health.error, duration_ms: Date.now() - roundStart,
      });
    }

    const autoHidden = autoHideOldTerms();
    if (autoHidden) report.autoHiddenCourses = autoHidden;
    const linked = linkDuplicates();
    if (linked) report.linkedDuplicates = linked;

    db.setSetting('last_sync', String(report.at));
    db.setSetting('last_sync_report', JSON.stringify(report));
    return report;
  } finally {
    syncing = false;
  }
}

/**
 * Ed announcements bury deadlines in prose. Heuristics first; only text that
 * clearly talks about a deadline but doesn't resolve to one date goes to the
 * claude queue. Runs post-insert only, so each announcement costs at most one
 * AI call ever.
 */
function extractAnnouncementDates(inserted) {
  for (const item of inserted) {
    if (item.kind !== 'announcement') continue;
    const text = `${item.title}\n${item.document || ''}`;

    const single = dates.extractSingle(text);
    if (single && single > Date.now() - 24 * 3600 * 1000) {
      db.setItemExtractedDue(item.id, single, 'heuristic');
      continue;
    }

    if (!dates.hasDeadlineKeyword(text) || !ai.claudeAvailable()) continue;

    // Fire and forget — the radar picks the date up on the next poll.
    ai.extractDueDate({
      title: item.title,
      text: item.document || '',
      courseCode: item.courseKey,
    }).then((epoch) => {
      if (epoch) db.setItemExtractedDue(item.id, epoch, 'claude');
    }).catch((err) => console.warn('[ed extract]', err.message));
  }
}

// ---------- current-term awareness ----------

// "Fall 2026", "2026 SU", GT SIS codes like "202608" — normalize to a
// {year, season} where season is 1 (spring), 5 (summer), or 8 (fall).
const SEASON_WORDS = { spring: 1, sp: 1, winter: 1, summer: 5, su: 5, fall: 8, autumn: 8, fa: 8 };
const normalizeMonth = (m) => (m >= 8 ? 8 : m >= 5 ? 5 : 1);

function termSeasonYear(term) {
  if (!term) return null;
  const s = String(term).toLowerCase();
  const code = s.match(/\b(20\d\d)(0[1-9]|1[0-2])\b/);
  if (code) return { year: +code[1], season: normalizeMonth(+code[2]) };
  const year = s.match(/\b(20\d\d)\b/);
  const season = s.match(/\b(spring|summer|fall|autumn|winter|sp|su|fa)\b/);
  if (!year || !season) return null;
  return { year: +year[1], season: SEASON_WORDS[season[1]] };
}

function currentTerm(now = new Date()) {
  return { year: now.getFullYear(), season: normalizeMonth(now.getMonth() + 1) };
}

/**
 * Hide courses that are clearly not part of the semester we are in:
 *  - a parseable term that isn't the current one (last spring's Canvas
 *    courses stay "active" forever otherwise), and
 *  - unparseable-term shells ("Default Term" orientation/advising sites)
 *    that have zero date-carrying work in the current window.
 * Runs after items are upserted, so the no-dated-work check sees fresh data.
 * Unhide in Settings is the escape hatch; a course that later gains real
 * deadlines passes the check and stays visible once unhidden.
 */
function autoHideOldTerms() {
  const cur = currentTerm();
  const now = Date.now();
  const datedItems = db.db.prepare(
    `SELECT COUNT(*) n FROM items
     WHERE course_id = ? AND due_at IS NOT NULL AND due_at > ? AND due_at < ?`
  );
  let hidden = 0;
  for (const c of db.listCourses({ includeHidden: true })) {
    if (c.hidden) continue;
    const t = termSeasonYear(c.term);
    const stale = t
      ? (t.year !== cur.year || t.season !== cur.season)
      : datedItems.get(c.id, now - 30 * 24 * 3600 * 1000, now + 180 * 24 * 3600 * 1000).n === 0;
    if (stale) {
      db.setCourseHidden(c.id, true);
      hidden++;
    }
  }
  return hidden;
}

// ---------- cross-source duplicate linking ----------

// Canvas usually mirrors Gradescope deadlines, and syllabus imports overlap
// both — the same homework must be ONE row on the radar. Matching is
// deliberately conservative: same normalized course code + same normalized
// title, due dates not contradicting each other.

const SOURCE_RANK = { canvas: 0, gradescope: 1, syllabus: 2 };
const STATUS_RANK = { done: 2, in_progress: 1, not_started: 0 };

const normCourseCode = (code) => {
  const m = String(code || '').toLowerCase().match(/([a-z]{2,4})[\s-]*(\d{4})/);
  return m ? m[1] + m[2] : null;
};

const normTitle = (t) => String(t || '').toLowerCase()
  .replace(/\bhw\b/g, 'homework')
  .replace(/\bproj\b/g, 'project')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function linkDuplicates() {
  const rows = db.db.prepare(
    `SELECT i.id, i.source, i.title, i.due_at, i.status, i.duplicate_of, c.code AS course_code
     FROM items i LEFT JOIN courses c ON c.id = i.course_id
     WHERE i.kind IN ('assignment', 'quiz', 'task') AND i.hidden = 0
       AND i.source IN ('canvas', 'gradescope', 'syllabus')`
  ).all();

  const groups = new Map();
  for (const r of rows) {
    const key = (normCourseCode(r.course_code) || 'none') + '|' + normTitle(r.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const setDup = db.db.prepare('UPDATE items SET duplicate_of = ? WHERE id = ?');
  const setStatus = db.db.prepare('UPDATE items SET status = ?, completed_at = ? WHERE id = ?');
  const DAY = 24 * 3600 * 1000;
  let linked = 0;

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // The same source twice in a group means the title is too generic to
    // trust ("Quiz" every week) — leave those alone.
    const sources = group.map((g) => g.source);
    if (new Set(sources).size !== sources.length) continue;

    const dues = group.filter((g) => g.due_at !== null).map((g) => g.due_at);
    if (dues.length >= 2 && Math.max(...dues) - Math.min(...dues) > 3 * DAY) continue;
    // Without a shared course code, only near-identical timing justifies a merge.
    if (key.startsWith('none|')) {
      if (dues.length !== group.length) continue;
      if (Math.max(...dues) - Math.min(...dues) > DAY) continue;
    }

    const sorted = [...group].sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9));
    const canonical = sorted[0];
    if (canonical.duplicate_of !== null) setDup.run(null, canonical.id);

    // The user may have checked off whichever copy they saw first — the
    // surviving row inherits the most-advanced status in the group.
    const best = group.reduce((m, g) => (STATUS_RANK[g.status] > STATUS_RANK[m.status] ? g : m), group[0]);
    if (STATUS_RANK[best.status] > STATUS_RANK[canonical.status]) {
      setStatus.run(best.status, best.status === 'done' ? Date.now() : null, canonical.id);
    }

    for (const g of sorted.slice(1)) {
      if (g.duplicate_of !== canonical.id) {
        setDup.run(canonical.id, g.id);
        linked++;
      }
    }
  }
  return linked;
}

function readReport() {
  try { return JSON.parse(db.getSetting('last_sync_report', 'null')); }
  catch { return null; }
}

const isSyncing = () => syncing;
const lastSyncAt = () => Number(db.getSetting('last_sync', '0')) || null;
const syncOne = (id) => sync(id);

function sourceStates() {
  return SOURCES.map((s) => ({ id: s.id, label: s.label, enabled: s.enabled() }));
}

module.exports = {
  sync, syncOne, isSyncing, lastSyncAt, readReport, sourceStates, SOURCES,
  termSeasonYear, currentTerm, autoHideOldTerms, linkDuplicates,
};

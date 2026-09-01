'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Packaged builds cannot write beside the exe; dev keeps data in the repo so
// it is easy to inspect. SCHOOL_TRACKER_DATA overrides both for headless runs.
function resolveDataDir() {
  if (process.env.SCHOOL_TRACKER_DATA) return process.env.SCHOOL_TRACKER_DATA;
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.join(app.getPath('userData'), 'data');
  } catch { /* plain node — fall through */ }
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const DEBUG_DIR = path.join(DATA_DIR, 'debug');
fs.mkdirSync(DEBUG_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'school.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS courses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    source_id  TEXT NOT NULL,
    code       TEXT,
    name       TEXT NOT NULL,
    term       TEXT,
    hidden     INTEGER NOT NULL DEFAULT 0,
    raw        TEXT,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    UNIQUE(source, source_id)
  );

  CREATE TABLE IF NOT EXISTS items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL,
    source_id        TEXT,
    course_id        INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    kind             TEXT NOT NULL DEFAULT 'assignment',
    title            TEXT NOT NULL,
    notes            TEXT NOT NULL DEFAULT '',
    url              TEXT,
    due_at           INTEGER,
    all_day          INTEGER NOT NULL DEFAULT 0,
    points           REAL,
    estimate_min     INTEGER,
    submitted        INTEGER,
    submitted_at     INTEGER,
    status           TEXT NOT NULL DEFAULT 'not_started',
    completed_at     INTEGER,
    hidden           INTEGER NOT NULL DEFAULT 0,
    raw              TEXT,
    ai_extracted_due INTEGER,
    ai_method        TEXT,
    first_seen       INTEGER NOT NULL,
    last_seen        INTEGER NOT NULL,
    missing_since    INTEGER,
    UNIQUE(source, source_id)
  );

  CREATE INDEX IF NOT EXISTS idx_items_due ON items(due_at);
  CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
  CREATE INDEX IF NOT EXISTS idx_items_course ON items(course_id);

  CREATE TABLE IF NOT EXISTS planned_blocks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id      INTEGER REFERENCES items(id) ON DELETE SET NULL,
    title        TEXT,
    date         TEXT NOT NULL,
    start_min    INTEGER,
    duration_min INTEGER NOT NULL DEFAULT 60,
    done         INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_blocks_date ON planned_blocks(date);

  CREATE TABLE IF NOT EXISTS notified (
    key     TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    source      TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    matched     INTEGER NOT NULL DEFAULT 0,
    added       INTEGER NOT NULL DEFAULT 0,
    updated     INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    duration_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_synclog_source ON sync_log(source, ok);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Columns added after the first release go here; ALTER is a no-op on fresh
// databases because CREATE TABLE above already includes them.
for (const [table, column, ddl] of []) {
  const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!present) db.exec(ddl);
}

const STATUSES = ['not_started', 'in_progress', 'done'];
const KINDS = ['assignment', 'quiz', 'event', 'announcement', 'task'];

// ---------- settings ----------

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

// Seed defaults on first run.
const DEFAULTS = {
  sync_interval_min: '30',
  digest_enabled: '1',
  digest_time: '07:30',
  canvas_base_url: 'https://gatech.instructure.com',
  ed_base_url: 'https://us.edstem.org/api',
  treat_submitted_as_done: '1',
  capture_hotkey: 'Control+Shift+Space',
  gradescope_state: 'never',
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (getSetting(k) === null) setSetting(k, v);
}

// ---------- courses ----------

function upsertCourse(course) {
  const now = Date.now();
  const existing = db
    .prepare('SELECT id FROM courses WHERE source = ? AND source_id = ?')
    .get(course.source, course.source_id);
  if (existing) {
    db.prepare(
      `UPDATE courses SET code = ?, name = ?, term = ?, raw = ?, last_seen = ? WHERE id = ?`
    ).run(course.code || null, course.name, course.term || null,
      course.raw ? JSON.stringify(course.raw) : null, now, existing.id);
    return existing.id;
  }
  const info = db.prepare(
    `INSERT INTO courses (source, source_id, code, name, term, raw, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(course.source, course.source_id, course.code || null, course.name,
    course.term || null, course.raw ? JSON.stringify(course.raw) : null, now, now);
  return Number(info.lastInsertRowid);
}

function listCourses({ includeHidden = false } = {}) {
  return db.prepare(
    `SELECT id, source, source_id, code, name, term, hidden FROM courses
     ${includeHidden ? '' : 'WHERE hidden = 0'}
     ORDER BY source, code, name`
  ).all().map((c) => ({ ...c, hidden: !!c.hidden }));
}

function setCourseHidden(id, hidden) {
  db.prepare('UPDATE courses SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
}

// ---------- items ----------

/**
 * Insert an item, or refresh the fields the source owns on one we already track.
 * Never touches status/notes/hidden/completed_at/estimate_min — those belong to
 * the user, not the feed. `preserveDue` keeps an existing due_at when the source
 * sends null (Ed announcements get their date from extraction, not the feed).
 * Returns { result: 'inserted' | 'updated', id }.
 */
function upsertItem(item) {
  const now = Date.now();
  const existing = db
    .prepare('SELECT id FROM items WHERE source = ? AND source_id = ?')
    .get(item.source, item.source_id);

  const raw = item.raw === undefined ? null : JSON.stringify(item.raw);
  const due = item.due_at ?? null;

  if (existing) {
    db.prepare(
      `UPDATE items SET
         course_id = ?, kind = ?, title = ?, url = ?,
         due_at = ${item.preserveDue ? 'COALESCE(?, due_at)' : '?'},
         all_day = ?, points = ?, submitted = ?, submitted_at = ?,
         raw = COALESCE(?, raw), last_seen = ?, missing_since = NULL
       WHERE id = ?`
    ).run(
      item.course_id ?? null, item.kind, item.title, item.url || null, due,
      item.all_day ? 1 : 0, item.points ?? null, item.submitted ?? null,
      item.submitted_at ?? null, raw, now, existing.id
    );
    return { result: 'updated', id: existing.id };
  }

  const info = db.prepare(
    `INSERT INTO items (source, source_id, course_id, kind, title, url, due_at,
                        all_day, points, submitted, submitted_at, raw, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    item.source, item.source_id, item.course_id ?? null, item.kind, item.title,
    item.url || null, due, item.all_day ? 1 : 0, item.points ?? null,
    item.submitted ?? null, item.submitted_at ?? null, raw, now, now
  );
  return { result: 'inserted', id: Number(info.lastInsertRowid) };
}

function createManualItem({ title, due_at = null, course_id = null, notes = '', estimate_min = null }) {
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO items (source, source_id, course_id, kind, title, notes, due_at,
                        estimate_min, first_seen, last_seen)
     VALUES ('manual', NULL, ?, 'task', ?, ?, ?, ?, ?, ?)`
  ).run(course_id, title, notes, due_at, estimate_min, now, now);
  return getItem(Number(info.lastInsertRowid));
}

function getItem(id) {
  const row = db.prepare(
    `SELECT i.*, c.code AS course_code, c.name AS course_name
     FROM items i LEFT JOIN courses c ON c.id = i.course_id
     WHERE i.id = ?`
  ).get(id);
  return row ? hydrateItem(row) : null;
}

function hydrateItem(row) {
  const { raw, ...rest } = row; // raw stays server-side; it can be large
  return {
    ...rest,
    all_day: !!row.all_day,
    hidden: !!row.hidden,
    submitted: row.submitted === null ? null : !!row.submitted,
  };
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

function listItems({
  from = null, to = null, q = '', course = null, source = '',
  includeDone = false, includeHidden = false, kinds = null,
} = {}) {
  const where = ['(i.missing_since IS NULL OR i.missing_since > ?)'];
  const params = [Date.now() - WEEK_MS];

  where.push('(c.id IS NULL OR c.hidden = 0)');
  if (!includeHidden) where.push('i.hidden = 0');
  if (!includeDone) where.push("i.status != 'done'");
  if (from !== null) { where.push('i.due_at >= ?'); params.push(from); }
  if (to !== null) { where.push('i.due_at < ?'); params.push(to); }
  if (course) { where.push('i.course_id = ?'); params.push(course); }
  if (source) { where.push('i.source = ?'); params.push(source); }
  if (kinds && kinds.length) {
    where.push(`i.kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  if (String(q).trim()) {
    where.push('(LOWER(i.title) LIKE ? OR LOWER(i.notes) LIKE ?)');
    const like = `%${String(q).trim().toLowerCase()}%`;
    params.push(like, like);
  }

  return db.prepare(
    `SELECT i.id, i.source, i.source_id, i.course_id, i.kind, i.title, i.notes,
            i.url, i.due_at, i.all_day, i.points, i.estimate_min, i.submitted,
            i.submitted_at, i.status, i.completed_at, i.hidden, i.ai_method,
            i.first_seen, i.missing_since,
            c.code AS course_code, c.name AS course_name
     FROM items i LEFT JOIN courses c ON c.id = i.course_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.due_at IS NULL, i.due_at ASC, i.first_seen DESC
     LIMIT 2000`
  ).all(...params).map(hydrateItem);
}

/** Update the user-owned fields; source-owned fields only for manual tasks. */
function updateItem(id, fields) {
  const row = db.prepare('SELECT source, status FROM items WHERE id = ?').get(id);
  if (!row) return null;

  const sets = [];
  const params = [];

  if (fields.status !== undefined) {
    if (!STATUSES.includes(fields.status)) throw new Error(`bad status: ${fields.status}`);
    sets.push('status = ?');
    params.push(fields.status);
    sets.push('completed_at = ?');
    params.push(fields.status === 'done' ? Date.now() : null);
  }
  if (fields.notes !== undefined) { sets.push('notes = ?'); params.push(String(fields.notes)); }
  if (fields.hidden !== undefined) { sets.push('hidden = ?'); params.push(fields.hidden ? 1 : 0); }
  if (fields.estimate_min !== undefined) {
    const v = fields.estimate_min === null ? null : Math.max(5, Math.min(24 * 60, Number(fields.estimate_min) || 0));
    sets.push('estimate_min = ?');
    params.push(v);
  }
  if (row.source === 'manual') {
    if (fields.title !== undefined) { sets.push('title = ?'); params.push(String(fields.title)); }
    if (fields.due_at !== undefined) { sets.push('due_at = ?'); params.push(fields.due_at); }
    if (fields.course_id !== undefined) { sets.push('course_id = ?'); params.push(fields.course_id); }
  }

  if (sets.length) {
    params.push(id);
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  return getItem(id);
}

function deleteManualItem(id) {
  const info = db.prepare("DELETE FROM items WHERE id = ? AND source = 'manual'").run(id);
  return info.changes > 0;
}

function setItemExtractedDue(id, epoch, method) {
  db.prepare(
    'UPDATE items SET ai_extracted_due = ?, ai_method = ?, due_at = COALESCE(due_at, ?) WHERE id = ?'
  ).run(epoch, method, epoch, id);
}

/** Items of a source untouched by the round that just finished vanish upstream. */
function markMissing(source, roundStart) {
  db.prepare(
    `UPDATE items SET missing_since = COALESCE(missing_since, ?)
     WHERE source = ? AND last_seen < ?`
  ).run(Date.now(), source, roundStart);
}

// ---------- planned blocks ----------

function hydrateBlock(row) {
  return { ...row, done: !!row.done };
}

function listBlocks({ from, to }) {
  return db.prepare(
    `SELECT b.*, i.title AS item_title, i.status AS item_status,
            i.source AS item_source, i.kind AS item_kind, i.due_at AS item_due_at,
            c.code AS course_code
     FROM planned_blocks b
     LEFT JOIN items i ON i.id = b.item_id
     LEFT JOIN courses c ON c.id = i.course_id
     WHERE b.date >= ? AND b.date <= ?
     ORDER BY b.date, b.start_min IS NULL, b.start_min`
  ).all(from, to).map(hydrateBlock);
}

function createBlock({ item_id = null, title = null, date, start_min = null, duration_min = 60 }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('bad date');
  if (!item_id && !String(title || '').trim()) throw new Error('a custom block needs a title');
  const info = db.prepare(
    `INSERT INTO planned_blocks (item_id, title, date, start_min, duration_min, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(item_id, title, date, start_min, clampDuration(duration_min), Date.now());
  return getBlock(Number(info.lastInsertRowid));
}

function getBlock(id) {
  const row = db.prepare(
    `SELECT b.*, i.title AS item_title, i.status AS item_status,
            i.source AS item_source, i.kind AS item_kind, i.due_at AS item_due_at,
            c.code AS course_code
     FROM planned_blocks b
     LEFT JOIN items i ON i.id = b.item_id
     LEFT JOIN courses c ON c.id = i.course_id
     WHERE b.id = ?`
  ).get(id);
  return row ? hydrateBlock(row) : null;
}

const clampDuration = (min) => Math.max(15, Math.min(16 * 60, Number(min) || 60));

function updateBlock(id, fields) {
  const sets = [];
  const params = [];
  if (fields.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fields.date))) throw new Error('bad date');
    sets.push('date = ?'); params.push(fields.date);
  }
  if (fields.start_min !== undefined) {
    sets.push('start_min = ?');
    params.push(fields.start_min === null ? null : Math.max(0, Math.min(24 * 60 - 15, Number(fields.start_min) || 0)));
  }
  if (fields.duration_min !== undefined) { sets.push('duration_min = ?'); params.push(clampDuration(fields.duration_min)); }
  if (fields.done !== undefined) { sets.push('done = ?'); params.push(fields.done ? 1 : 0); }
  if (fields.title !== undefined) { sets.push('title = ?'); params.push(fields.title); }
  if (!sets.length) return getBlock(id);
  params.push(id);
  db.prepare(`UPDATE planned_blocks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getBlock(id);
}

function deleteBlock(id) {
  return db.prepare('DELETE FROM planned_blocks WHERE id = ?').run(id).changes > 0;
}

// ---------- notifications ----------

function wasNotified(key) {
  return !!db.prepare('SELECT key FROM notified WHERE key = ?').get(key);
}

function markNotified(key) {
  db.prepare(
    'INSERT INTO notified (key, sent_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  ).run(key, Date.now());
}

function pruneOld() {
  db.prepare('DELETE FROM notified WHERE sent_at < ?').run(Date.now() - 30 * 24 * 3600 * 1000);
  db.prepare('DELETE FROM sync_log WHERE at < ?').run(Date.now() - 60 * 24 * 3600 * 1000);
}

// ---------- sync log ----------

function logSync(entry) {
  db.prepare(
    `INSERT INTO sync_log (at, source, ok, matched, added, updated, error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(entry.at, entry.source, entry.ok ? 1 : 0, entry.matched | 0, entry.added | 0,
    entry.updated | 0, entry.error ? String(entry.error).slice(0, 2000) : null,
    entry.duration_ms | 0);
}

/** True once a source has ever completed a successful sync (toast suppression). */
function hasSyncedBefore(source) {
  return !!db.prepare('SELECT id FROM sync_log WHERE source = ? AND ok = 1 LIMIT 1').get(source);
}

// ---------- stats ----------

function stats() {
  const now = new Date();
  // Week starts Monday, local time.
  const day = (now.getDay() + 6) % 7;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day).getTime();

  const completedThisWeek = db.prepare(
    `SELECT COUNT(*) n FROM items WHERE status = 'done' AND completed_at >= ?`
  ).get(weekStart).n;

  const perCourse = db.prepare(
    `SELECT c.id, c.code, c.name,
            SUM(CASE WHEN i.status = 'done' THEN 1 ELSE 0 END) AS done,
            COUNT(i.id) AS total
     FROM courses c
     JOIN items i ON i.course_id = c.id
       AND i.hidden = 0 AND i.kind IN ('assignment', 'quiz', 'task')
       AND (i.missing_since IS NULL OR i.missing_since > ?)
     WHERE c.hidden = 0
     GROUP BY c.id ORDER BY c.code, c.name`
  ).all(Date.now() - WEEK_MS);

  return { completedThisWeek, weekStart, perCourse };
}

module.exports = {
  db, DATA_DIR, DEBUG_DIR, STATUSES, KINDS,
  getSetting, setSetting,
  upsertCourse, listCourses, setCourseHidden,
  upsertItem, createManualItem, getItem, listItems, updateItem, deleteManualItem,
  setItemExtractedDue, markMissing,
  listBlocks, createBlock, getBlock, updateBlock, deleteBlock,
  wasNotified, markNotified, pruneOld,
  logSync, hasSyncedBefore,
  stats,
};

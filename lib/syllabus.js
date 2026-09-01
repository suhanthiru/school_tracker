'use strict';

// Syllabus ingestion: paste text (works for everyone — heuristic line scan)
// or hand the claude CLI a PDF/document path to read. Items land as
// source='syllabus' with a per-course dedupe id, so re-importing an updated
// syllabus refreshes dates instead of duplicating rows.

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const ai = require('./ai');
const dates = require('./dates');
const bridge = require('./bridge');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const KIND_HINT = /\b(quiz|exam|midterm|final|test)\b/i;
const DELIVERABLE_HINT = /\b(due|hw|homework|pset|problem set|project|quiz|exam|midterm|final|essay|paper|report|presentation|lab|assignment|milestone)\b/i;

/**
 * No-AI fallback: any line naming a deliverable AND resolving to exactly one
 * date becomes an item. Coarse but honest — the AI path is strictly better.
 */
function heuristicExtract(text, now = Date.now()) {
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 6 || line.length > 300) continue;
    if (!DELIVERABLE_HINT.test(line)) continue;
    const due = dates.extractSingle(line, now);
    if (!due) continue;
    out.push({
      title: line.replace(/\s{2,}/g, ' ').slice(0, 200),
      kind: KIND_HINT.test(line) ? 'quiz' : 'assignment',
      due,
      points: null,
    });
    if (out.length >= 60) break;
  }
  return out;
}

/** Upsert extracted entries as items. Returns counts. */
function materialize(entries, courseId) {
  let added = 0;
  let updated = 0;
  for (const e of entries) {
    const { result } = db.upsertItem({
      source: 'syllabus',
      source_id: `${courseId || 'none'}:${slug(e.title)}`,
      course_id: courseId || null,
      kind: e.kind,
      title: e.title,
      url: null,
      due_at: e.due,
      points: e.points,
      raw: e,
    });
    if (result === 'inserted') added++;
    else updated++;
  }
  return { added, updated, total: entries.length };
}

async function importText(text, courseId) {
  if (!String(text || '').trim()) throw new Error('no syllabus text given');
  const course = courseId ? db.listCourses({ includeHidden: true }).find((c) => c.id === courseId) : null;

  let entries;
  let method;
  if (ai.claudeAvailable()) {
    entries = await ai.extractSyllabus({ text, courseCode: course ? course.code : '' });
    method = 'claude';
  } else {
    entries = heuristicExtract(text);
    method = 'heuristic';
  }
  return { ...materialize(entries, courseId), method };
}

async function importFile(filePath, courseId) {
  if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();

  if (['.txt', '.md', '.text'].includes(ext)) {
    return importText(fs.readFileSync(filePath, 'utf8'), courseId);
  }

  if (!ai.claudeAvailable()) {
    throw new Error('reading PDF/document syllabi needs the claude CLI — paste the text instead');
  }
  const course = courseId ? db.listCourses({ includeHidden: true }).find((c) => c.id === courseId) : null;
  const entries = await ai.extractSyllabus({ filePath, courseCode: course ? course.code : '' });
  return { ...materialize(entries, courseId), method: 'claude' };
}

/** Electron file-pick flow: main.js answers 'syllabus-pick' with a dialog. */
function pickAndImport(courseId) {
  bridge.emit('syllabus-pick', {
    courseId,
    onFile: (filePath) => importFile(filePath, courseId)
      .then((r) => bridge.emit('toast', {
        title: `Syllabus imported — ${r.total} items`,
        body: `${r.added} new, ${r.updated} updated`,
        route: '#radar',
        at: Date.now(),
      }))
      .catch((err) => bridge.emit('toast', {
        title: 'Syllabus import failed',
        body: err.message,
        at: Date.now(),
      })),
  });
}

module.exports = { importText, importFile, pickAndImport, heuristicExtract };

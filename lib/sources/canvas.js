'use strict';

// Canvas REST adapter. Two auth modes:
//  - token: a personal access token (schools that allow them)
//  - session: the app's own Canvas SSO sign-in window (persist:canvas
//    partition) — Georgia Tech blocks student-created tokens, and Canvas's
//    REST API happily accepts its session cookie, which is exactly how the
//    Canvas web UI itself fetches data.

const SUBMITTED_STATES = new Set(['submitted', 'graded', 'pending_review']);
const PARTITION = 'persist:canvas';

function sessionFetch(url) {
  let electron;
  try { electron = require('electron'); } catch {
    throw new Error('Canvas session sync only works inside the desktop app');
  }
  if (!electron.session) throw new Error('Canvas session sync only works inside the desktop app');
  return electron.session.fromPartition(PARTITION).fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'follow',
  });
}

async function fetchJson(url, ctx) {
  let res;
  if (ctx.token) {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(60000),
    });
  } else {
    res = await sessionFetch(url);
  }

  if (res.status === 401 || /\/login/.test(res.url)) {
    if (ctx.token) {
      throw new Error('Canvas token rejected — generate a new one in Canvas → Account → Settings');
    }
    const err = new Error('Canvas session expired — reconnect from Settings');
    err.expired = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Canvas HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  // Canvas prefixes JSON with a defensive "while(1);" on some session
  // responses — strip it before parsing.
  const text = (await res.text()).replace(/^while\(1\);/, '');
  let body;
  try { body = JSON.parse(text); } catch {
    const err = new Error('Canvas returned something that is not JSON (session probably expired)');
    if (!ctx.token) err.expired = true;
    throw err;
  }
  return { body, link: res.headers.get('link') || '' };
}

/** Follow the Link: rel="next" chain — Canvas caps per_page at 100. */
async function paged(url, ctx) {
  const out = [];
  let next = url;
  for (let page = 0; next && page < 50; page++) {
    const { body, link } = await fetchJson(next, ctx);
    if (!Array.isArray(body)) throw new Error('Canvas returned a non-list where a list was expected');
    out.push(...body);
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}

const parseTs = (iso) => (iso ? Date.parse(iso) || null : null);

function normalizeAssignment(a) {
  const sub = a.submission || null;
  const kind = (a.is_quiz_assignment || (a.submission_types || []).includes('online_quiz'))
    ? 'quiz' : 'assignment';
  return {
    source: 'canvas',
    source_id: `assignment:${a.id}`,
    courseKey: String(a.course_id),
    kind,
    title: a.name || '(untitled assignment)',
    url: a.html_url || null,
    due_at: parseTs(a.due_at),
    points: a.points_possible ?? null,
    submitted: sub ? (SUBMITTED_STATES.has(sub.workflow_state) ? 1 : 0) : null,
    submitted_at: sub ? parseTs(sub.submitted_at) : null,
    raw: a,
  };
}

function baseOf(ctx) {
  const base = String(ctx.baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Canvas base URL is not set');
  return base;
}

/** One cheap authenticated call, for the Settings test button. */
async function whoami(ctx) {
  const { body } = await fetchJson(`${baseOf(ctx)}/api/v1/users/self`, ctx);
  return body;
}

/**
 * ctx: { baseUrl, token? } — no token means session mode.
 * → { courses, items, notes } normalized for sync.js
 */
async function fetchAll(ctx) {
  const base = baseOf(ctx);

  const notes = [];
  const rawCourses = await paged(
    `${base}/api/v1/courses?enrollment_state=active&per_page=100&include[]=term`,
    ctx
  );

  const courses = [];
  for (const c of rawCourses) {
    if (c.access_restricted_by_date) continue;
    if (!c.name) continue;
    courses.push({
      source: 'canvas',
      source_id: String(c.id),
      code: c.course_code || null,
      name: c.name,
      term: (c.term && c.term.name) || null,
      raw: c,
    });
  }

  const items = [];
  for (const course of courses) {
    try {
      const assignments = await paged(
        `${base}/api/v1/courses/${course.source_id}/assignments?per_page=100&include[]=submission&order_by=due_at`,
        ctx
      );
      for (const a of assignments) {
        if (!a || a.workflow_state === 'deleted') continue;
        items.push(normalizeAssignment(a));
      }
    } catch (err) {
      if (err.expired) throw err;
      // Concluded or restricted courses 403 on assignments; that must not
      // take down the whole source.
      if (err.status === 403 || err.status === 404) {
        notes.push(`${course.code || course.name}: assignments not accessible (${err.status})`);
        continue;
      }
      throw err;
    }
  }

  return { courses, items, notes };
}

module.exports = { id: 'canvas', label: 'Canvas', fetchAll, whoami, PARTITION };

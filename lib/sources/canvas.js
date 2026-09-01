'use strict';

// Canvas REST adapter — the one source with a real, sanctioned API.
// Personal access token from Canvas → Account → Settings → New Access Token.

const SUBMITTED_STATES = new Set(['submitted', 'graded', 'pending_review']);

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  if (res.status === 401) {
    throw new Error('Canvas token rejected — generate a new one in Canvas → Account → Settings');
  }
  if (!res.ok) {
    const err = new Error(`Canvas HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { body: await res.json(), link: res.headers.get('link') || '' };
}

/** Follow the Link: rel="next" chain — Canvas caps per_page at 100. */
async function paged(url, token) {
  const out = [];
  let next = url;
  for (let page = 0; next && page < 50; page++) {
    const { body, link } = await fetchJson(next, token);
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

/**
 * ctx: { baseUrl, token }
 * → { courses, items, notes } normalized for sync.js
 */
async function fetchAll(ctx) {
  const base = String(ctx.baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Canvas base URL is not set');
  if (!ctx.token) throw new Error('no Canvas token');

  const notes = [];
  const rawCourses = await paged(
    `${base}/api/v1/courses?enrollment_state=active&per_page=100&include[]=term`,
    ctx.token
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
        ctx.token
      );
      for (const a of assignments) {
        if (!a || a.workflow_state === 'deleted') continue;
        items.push(normalizeAssignment(a));
      }
    } catch (err) {
      // Concluded or restricted courses 403 on assignments; that must not
      // take down the whole source.
      if (err.status === 403 || err.status === 404 || err.status === 401) {
        notes.push(`${course.code || course.name}: assignments not accessible (${err.status})`);
        continue;
      }
      throw err;
    }
  }

  return { courses, items, notes };
}

module.exports = { id: 'canvas', label: 'Canvas', fetchAll };

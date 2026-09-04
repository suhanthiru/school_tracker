'use strict';

// Canvas REST adapter. Two auth modes:
//  - token: a personal access token (schools that allow them)
//  - session: the app's own Canvas SSO sign-in window (persist:canvas
//    partition) — Georgia Tech blocks student-created tokens, and Canvas's
//    REST API happily accepts its session cookie, which is exactly how the
//    Canvas web UI itself fetches data.
//
// Canvas is NOT one feed. Work reaches a student through assignments,
// classic quizzes, graded and ungraded discussions, pages carrying a to-do
// date, calendar events, peer reviews, and LTI tools (Perusall, publisher
// platforms) that hang off an assignment. The planner endpoint is the
// umbrella Canvas's own dashboard reads. This adapter pulls all of them and
// folds them into one deduped list, so nothing hides in a corner of Canvas.

const SUBMITTED_STATES = new Set(['submitted', 'graded', 'pending_review']);
const PARTITION = 'persist:canvas';

const PLANNER_BACK_DAYS = 14;
const PLANNER_FWD_DAYS = 180;

// An assignment of type "external_tool" says nothing useful; naming the tool
// tells the student exactly where the work actually lives.
const PROVIDERS = [
  [/perusall/i, 'Perusall'],
  [/gradescope/i, 'Gradescope'],
  [/turnitin|tii-/i, 'Turnitin'],
  [/mheducation|mhhe\./i, 'McGraw Hill'],
  [/pearson|mylab|mastering/i, 'Pearson'],
  [/webassign|cengage/i, 'Cengage'],
  [/tophat/i, 'Top Hat'],
  [/zybook/i, 'zyBooks'],
  [/wileyplus|wiley\./i, 'Wiley'],
  [/macmillan|achieve\./i, 'Macmillan'],
  [/edpuzzle/i, 'Edpuzzle'],
  [/packback/i, 'Packback'],
  [/kritik/i, 'Kritik'],
  [/playposit/i, 'PlayPosit'],
  [/deltamath/i, 'DeltaMath'],
  [/myopenmath|edfinity|gradarius/i, 'Math platform'],
  [/aleks/i, 'ALEKS'],
  [/labflow/i, 'Labflow'],
  [/expert-?ta/i, 'ExpertTA'],
  [/piazza/i, 'Piazza'],
  [/echo360|panopto|kaltura/i, 'Lecture capture'],
  [/pressbooks|libretexts/i, 'Textbook'],
];

function providerOf(a) {
  const url = (a && a.external_tool_tag_attributes && a.external_tool_tag_attributes.url)
    || (a && a.url) || '';
  if (!url) return null;
  for (const [re, name] of PROVIDERS) if (re.test(url)) return name;
  return null;
}

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
async function paged(url, ctx, maxPages = 50) {
  const out = [];
  let next = url;
  for (let page = 0; next && page < maxPages; page++) {
    const { body, link } = await fetchJson(next, ctx);
    if (!Array.isArray(body)) throw new Error('Canvas returned a non-list where a list was expected');
    out.push(...body);
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}

/**
 * A feed that is missing or forbidden for one course (concluded courses,
 * disabled tabs) must never take down the whole sync — collect and move on.
 */
async function tryPaged(url, ctx, label, notes, maxPages = 50) {
  try {
    return await paged(url, ctx, maxPages);
  } catch (err) {
    if (err.expired) throw err;
    if (err.status === 403 || err.status === 404 || err.status === 401) return [];
    notes.push(`${label}: ${err.message}`);
    return [];
  }
}

const parseTs = (iso) => (iso ? Date.parse(iso) || null : null);

const stripHtml = (html) => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

function submittedOf(sub) {
  if (!sub || typeof sub !== 'object') return null;
  if (sub.workflow_state) return SUBMITTED_STATES.has(sub.workflow_state) ? 1 : 0;
  // Planner shape: { submitted, graded, excused, ... }
  if ('submitted' in sub) return (sub.submitted || sub.graded || sub.excused) ? 1 : 0;
  return null;
}

function normalizeAssignment(a, courseKey) {
  const sub = a.submission || null;
  const isQuiz = a.is_quiz_assignment || (a.submission_types || []).includes('online_quiz');
  return {
    source: 'canvas',
    source_id: `assignment:${a.id}`,
    courseKey: String(courseKey ?? a.course_id ?? ''),
    kind: isQuiz ? 'quiz' : 'assignment',
    title: a.name || '(untitled assignment)',
    url: a.html_url || null,
    due_at: parseTs(a.due_at),
    points: a.points_possible ?? null,
    provider: providerOf(a),
    submitted: submittedOf(sub),
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
  const tally = { assignments: 0, quizzes: 0, discussions: 0, announcements: 0, planner: 0, events: 0 };

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
  const activeCourseIds = new Set(courses.map((c) => c.source_id));

  // One row per source_id; the richest feed writes first and wins, so a
  // graded quiz that also shows up in the planner stays a single item.
  const byId = new Map();
  const add = (item) => { if (item && !byId.has(item.source_id)) byId.set(item.source_id, item); };

  // Canvas exposes the same work under different ids depending on the feed;
  // these maps let planner rows land on the assignment row they belong to.
  const quizToAssignment = new Map();
  const discussionToAssignment = new Map();

  for (const course of courses) {
    const cid = course.source_id;
    const label = course.code || course.name;

    // 1. Assignments — includes LTI/Perusall work and graded quizzes.
    for (const a of await tryPaged(
      `${base}/api/v1/courses/${cid}/assignments?per_page=100&include[]=submission&order_by=due_at`,
      ctx, `${label} assignments`, notes
    )) {
      if (!a || a.workflow_state === 'deleted') continue;
      add(normalizeAssignment(a, cid));
      tally.assignments++;
    }

    // 2. Classic quizzes — practice quizzes and surveys have no assignment row.
    for (const q of await tryPaged(
      `${base}/api/v1/courses/${cid}/quizzes?per_page=100`,
      ctx, `${label} quizzes`, notes, 5
    )) {
      if (!q || !q.id) continue;
      if (q.assignment_id) {
        quizToAssignment.set(String(q.id), String(q.assignment_id));
        if (byId.has(`assignment:${q.assignment_id}`)) continue;
      }
      add({
        source: 'canvas',
        source_id: q.assignment_id ? `assignment:${q.assignment_id}` : `quiz:${q.id}`,
        courseKey: cid,
        kind: 'quiz',
        title: q.title || '(untitled quiz)',
        url: q.html_url || null,
        due_at: parseTs(q.due_at || q.lock_at),
        points: q.points_possible ?? null,
        provider: null,
        submitted: null,
        raw: q,
      });
      tally.quizzes++;
    }

    // 3. Discussions — graded ones carry an assignment; ungraded ones can
    //    still carry a to-do date the student is expected to hit.
    for (const d of await tryPaged(
      `${base}/api/v1/courses/${cid}/discussion_topics?per_page=50`,
      ctx, `${label} discussions`, notes, 3
    )) {
      if (!d || !d.id) continue;
      const assignmentId = d.assignment_id || (d.assignment && d.assignment.id);
      if (assignmentId) {
        discussionToAssignment.set(String(d.id), String(assignmentId));
        if (byId.has(`assignment:${assignmentId}`)) continue;
      }
      const due = parseTs(d.todo_date || (d.assignment && d.assignment.due_at));
      if (!assignmentId && !due) continue; // an undated chat thread is not work
      add({
        source: 'canvas',
        source_id: assignmentId ? `assignment:${assignmentId}` : `discussion:${d.id}`,
        courseKey: cid,
        kind: 'assignment',
        title: d.title || '(untitled discussion)',
        url: d.html_url || null,
        due_at: due,
        points: (d.assignment && d.assignment.points_possible) ?? null,
        provider: 'Discussion',
        submitted: null,
        raw: d,
      });
      tally.discussions++;
    }

    // 4. Announcements — deadlines hide in prose here exactly like on Ed, so
    //    they go through the same extraction pipeline.
    for (const a of await tryPaged(
      `${base}/api/v1/courses/${cid}/discussion_topics?only_announcements=true&per_page=15`,
      ctx, `${label} announcements`, notes, 1
    )) {
      if (!a || !a.id) continue;
      add({
        source: 'canvas',
        source_id: `announcement:${a.id}`,
        courseKey: cid,
        kind: 'announcement',
        title: a.title || '(untitled announcement)',
        url: a.html_url || null,
        due_at: null,
        preserveDue: true,
        provider: null,
        raw: { posted_at: a.posted_at },
        document: stripHtml(a.message).slice(0, 6000),
      });
      tally.announcements++;
    }
  }

  // 5. The planner: what Canvas's own dashboard shows. Catches pages with
  //    to-do dates, planner notes, calendar events and anything living in a
  //    course feed we did not enumerate above.
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const now = Date.now();
  const planner = await tryPaged(
    `${base}/api/v1/planner/items?start_date=${iso(now - PLANNER_BACK_DAYS * 86400000)}`
      + `&end_date=${iso(now + PLANNER_FWD_DAYS * 86400000)}&per_page=100`,
    ctx, 'planner', notes, 10
  );

  for (const p of planner) {
    if (!p || !p.plannable) continue;
    const courseKey = p.course_id ? String(p.course_id) : null;
    if (courseKey && !activeCourseIds.has(courseKey)) continue;

    const pl = p.plannable;
    const id = String(p.plannable_id ?? pl.id ?? '');
    if (!id) continue;
    const when = parseTs(p.plannable_date || pl.due_at || pl.todo_date || pl.start_at);

    let sourceId = null;
    let kind = 'assignment';
    switch (p.plannable_type) {
      case 'assignment': sourceId = `assignment:${id}`; break;
      case 'quiz':
        sourceId = quizToAssignment.has(id)
          ? `assignment:${quizToAssignment.get(id)}` : `quiz:${id}`;
        kind = 'quiz';
        break;
      case 'discussion_topic':
        sourceId = discussionToAssignment.has(id)
          ? `assignment:${discussionToAssignment.get(id)}` : `discussion:${id}`;
        break;
      case 'wiki_page': sourceId = `page:${id}`; kind = 'task'; break;
      case 'planner_note': sourceId = `note:${id}`; kind = 'task'; break;
      case 'calendar_event': sourceId = `event:${id}`; kind = 'event'; break;
      case 'assessment_request': sourceId = `peer:${id}`; kind = 'task'; break;
      case 'sub_assignment': sourceId = `subassignment:${id}`; break;
      default: sourceId = `${p.plannable_type || 'item'}:${id}`;
    }
    if (byId.has(sourceId)) continue;
    if (!when) continue;

    add({
      source: 'canvas',
      source_id: sourceId,
      courseKey,
      kind,
      title: pl.title || pl.name || '(untitled)',
      url: p.html_url ? (p.html_url.startsWith('http') ? p.html_url : base + p.html_url) : null,
      due_at: when,
      all_day: p.plannable_type === 'calendar_event' && !!pl.all_day,
      points: pl.points_possible ?? null,
      provider: p.plannable_type === 'planner_note' ? 'To-do'
        : p.plannable_type === 'wiki_page' ? 'Page'
        : p.plannable_type === 'assessment_request' ? 'Peer review' : null,
      submitted: submittedOf(p.submissions),
      raw: p,
    });
    if (kind === 'event') tally.events++; else tally.planner++;
  }

  notes.push(
    `assignments ${tally.assignments} · quizzes ${tally.quizzes} · discussions ${tally.discussions}`
    + ` · planner ${tally.planner} · events ${tally.events} · announcements ${tally.announcements}`
  );

  return { courses, items: [...byId.values()], notes };
}

module.exports = { id: 'canvas', label: 'Canvas', fetchAll, whoami, PARTITION, providerOf, stripHtml };

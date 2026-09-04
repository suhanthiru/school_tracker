
'use strict';

// Canvas adapter checks against mocked API responses: every feed Canvas hides
// work in, and the dedupe that keeps one piece of work as one row.

process.env.SCHOOL_TRACKER_DATA = require('node:os').tmpdir() + '/st-canvas-test-' + Date.now();
const canvas = require('../lib/sources/canvas.js');

const FIXTURES = [
  [/\/courses\?enrollment_state/, [
    { id: 1, name: 'Applied Combinatorics', course_code: 'MATH-3012', term: { name: 'Fall 2026' } },
  ]],
  [/\/courses\/1\/assignments/, [
    { id: 11, name: 'Homework 1', due_at: '2026-09-10T03:59:00Z', points_possible: 20,
      html_url: 'https://c/courses/1/assignments/11', submission: { workflow_state: 'unsubmitted' } },
    { id: 12, name: 'Reading 3', due_at: '2026-09-08T03:59:00Z', points_possible: 5,
      submission_types: ['external_tool'],
      external_tool_tag_attributes: { url: 'https://app.perusall.com/lti/launch' } },
    { id: 13, name: 'Quiz 2', is_quiz_assignment: true, due_at: '2026-09-12T03:59:00Z' },
  ]],
  [/\/courses\/1\/quizzes/, [
    { id: 91, title: 'Quiz 2', assignment_id: 13 },
    { id: 92, title: 'Practice Quiz', quiz_type: 'practice_quiz', due_at: '2026-09-14T03:59:00Z' },
  ]],
  [/only_announcements=true/, [
    { id: 71, title: 'Exam moved', message: '<p>The midterm is moved to <b>Oct 12</b>.</p>' },
  ]],
  [/\/courses\/1\/discussion_topics/, [
    { id: 61, title: 'Graded Discussion', assignment_id: 14,
      assignment: { id: 14, due_at: '2026-09-11T03:59:00Z', points_possible: 10 } },
    { id: 62, title: 'Intro thread', todo_date: '2026-09-09T03:59:00Z' },
    { id: 63, title: 'random chat with no date' },
  ]],
  [/\/planner\/items/, [
    { plannable_type: 'assignment', plannable_id: 11, course_id: 1,
      plannable: { title: 'Homework 1' }, plannable_date: '2026-09-10T03:59:00Z' },
    { plannable_type: 'quiz', plannable_id: 91, course_id: 1,
      plannable: { title: 'Quiz 2' }, plannable_date: '2026-09-12T03:59:00Z' },
    { plannable_type: 'wiki_page', plannable_id: 31, course_id: 1,
      plannable: { title: 'Read the syllabus' }, plannable_date: '2026-09-05T03:59:00Z' },
    { plannable_type: 'planner_note', plannable_id: 41, course_id: 1,
      plannable: { title: 'Buy the textbook' }, plannable_date: '2026-09-06T03:59:00Z' },
    { plannable_type: 'calendar_event', plannable_id: 51, course_id: 1,
      plannable: { title: 'Review session' }, plannable_date: '2026-09-07T20:00:00Z' },
    { plannable_type: 'assessment_request', plannable_id: 81, course_id: 1,
      plannable: { title: 'Peer review of Essay 1' }, plannable_date: '2026-09-13T03:59:00Z' },
    { plannable_type: 'assignment', plannable_id: 99, course_id: 999,
      plannable: { title: 'From a course we do not track' }, plannable_date: '2026-09-10T03:59:00Z' },
  ]],
];

globalThis.fetch = async (url) => {
  for (const [re, body] of FIXTURES) {
    if (re.test(url)) {
      return {
        ok: true, status: 200, url,
        text: async () => JSON.stringify(body),
        headers: { get: () => null },
      };
    }
  }
  return { ok: true, status: 200, url, text: async () => '[]', headers: { get: () => null } };
};

let failures = 0;
const check = (label, actual, expected) => {
  if (actual === expected) { console.log('ok   ' + label); return; }
  failures++;
  console.error(`FAIL ${label}\n  got      ${actual}\n  expected ${expected}`);
};

(async () => {
  const { courses, items, notes } = await canvas.fetchAll({
    baseUrl: 'https://c', token: 'fake',
  });

  check('courses parsed', courses.length, 1);

  const byId = new Map(items.map((i) => [i.source_id, i]));
  const ids = [...byId.keys()].sort().join(', ');
  console.log('     items: ' + ids);

  check('one row per piece of work', items.length, 11);

  // Every feed contributed.
  check('assignment kept', byId.has('assignment:11'), true);
  check('perusall assignment kept', byId.has('assignment:12'), true);
  check('perusall named', byId.get('assignment:12').provider, 'Perusall');
  check('graded quiz stays one row', byId.has('assignment:13'), true);
  check('graded quiz typed as quiz', byId.get('assignment:13').kind, 'quiz');
  check('practice quiz kept', byId.has('quiz:92'), true);
  check('graded discussion kept', byId.has('assignment:14'), true);
  check('ungraded discussion with todo date kept', byId.has('discussion:62'), true);
  check('undated chat thread skipped', byId.has('discussion:63'), false);
  check('announcement kept', byId.has('announcement:71'), true);
  check('announcement text extracted', /midterm is moved to Oct 12/.test(byId.get('announcement:71').document), true);
  check('page with todo date kept', byId.has('page:31'), true);
  check('planner note kept', byId.has('note:41'), true);
  check('calendar event kept', byId.has('event:51'), true);
  check('peer review kept', byId.has('peer:81'), true);
  check('peer review labelled', byId.get('peer:81').provider, 'Peer review');

  // Dedupe: planner echoes of work already pulled must not create rows.
  check('planner assignment echo deduped', items.filter((i) => i.source_id === 'assignment:11').length, 1);
  check('planner quiz mapped onto its assignment', byId.has('quiz:91'), false);
  check('foreign course item skipped', [...byId.keys()].some((k) => k.endsWith(':99')), false);

  console.log('     ' + notes[notes.length - 1]);
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nall canvas adapter tests passed');
})().catch((err) => { console.error(err); process.exit(1); });

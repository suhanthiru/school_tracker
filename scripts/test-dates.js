'use strict';

// Deterministic checks for the heuristic date extractor.
// Reference "now": Monday 2026-08-31 10:00 local.

const dates = require('../lib/dates');

const NOW = new Date(2026, 7, 31, 10, 0).getTime();
const at = (y, m, d, h = 23, mi = 59) => new Date(y, m - 1, d, h, mi).getTime();

let failures = 0;
function check(label, actual, expected) {
  const okRes = actual === expected;
  if (!okRes) {
    failures++;
    const show = (v) => (v === null ? 'null' : new Date(v).toString());
    console.error(`FAIL ${label}\n  got      ${show(actual)}\n  expected ${show(expected)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// extractSingle: exactly one calendar day or null
check('quiz moved to Friday', dates.extractSingle('Quiz 3 moved to Friday', NOW), at(2026, 9, 4));
check('due 9/15 at 5pm', dates.extractSingle('PS4 due 9/15 at 5pm', NOW), at(2026, 9, 15, 17, 0));
check('due tomorrow 11:59pm', dates.extractSingle('HW3 due tomorrow 11:59pm', NOW), at(2026, 9, 1));
check('exam on Oct 12', dates.extractSingle('Reminder: exam on Oct 12', NOW), at(2026, 10, 12));
check('today at noon', dates.extractSingle('Extra office hours today at noon', NOW), at(2026, 8, 31, 12, 0));
check('Sept 22nd, 7:00 pm', dates.extractSingle('Midterm 1 is Sept 22nd, 7:00 pm', NOW), at(2026, 9, 22, 19, 0));
check('thursday resolves forward', dates.extractSingle('quiz thursday', NOW), at(2026, 9, 3));
check('two days → null', dates.extractSingle('project due friday or saturday', NOW), null);
check('no dates → null', dates.extractSingle('great job on the exam everyone', NOW), null);
check('time only → null', dates.extractSingle('meeting at 3pm', NOW), null);
check('year rollover 1/15', dates.extractSingle('final report due 1/15', NOW), at(2027, 1, 15));
check('deadline extended to monday', dates.extractSingle('deadline extended to Monday', NOW), at(2026, 9, 7));

// parseCapture: title stripped of date phrasing
{
  const r = dates.parseCapture('read ch 7 by fri 5pm', NOW);
  check('capture: due', r.due_at, at(2026, 9, 4, 17, 0));
  if (r.title !== 'read ch 7') { failures++; console.error(`FAIL capture title: "${r.title}"`); }
  else console.log('ok   capture: title stripped');
}
{
  const r = dates.parseCapture('submit reimbursement form', NOW);
  check('capture: undated', r.due_at, null);
  if (r.title !== 'submit reimbursement form') { failures++; console.error(`FAIL capture title kept: "${r.title}"`); }
  else console.log('ok   capture: undated title kept');
}
{
  const r = dates.parseCapture('email prof about regrade tomorrow', NOW);
  check('capture: tomorrow', r.due_at, at(2026, 9, 1));
}
{
  const r = dates.parseCapture('do quiz 3 https://canvas.gatech.edu/courses/12/quizzes/9 by fri', NOW);
  check('capture: url + date', r.due_at, at(2026, 9, 4));
  if (r.url !== 'https://canvas.gatech.edu/courses/12/quizzes/9') { failures++; console.error(`FAIL capture url: "${r.url}"`); }
  else console.log('ok   capture: url extracted');
  if (r.title !== 'do quiz 3') { failures++; console.error(`FAIL capture url title: "${r.title}"`); }
  else console.log('ok   capture: url stripped from title');
}
{
  // digits inside a URL must not be read as a date
  const r = dates.parseCapture('review https://example.com/2026/09/15/post', NOW);
  check('capture: url digits not a date', r.due_at, null);
}

// keyword gate
for (const [text, expect] of [
  ['The quiz is postponed', true],
  ['pset 5 clarification', true],
  ['welcome to the course!', false],
]) {
  const got = dates.hasDeadlineKeyword(text);
  if (got !== expect) { failures++; console.error(`FAIL keyword "${text}"`); }
  else console.log(`ok   keyword: "${text}" → ${got}`);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall date tests passed');

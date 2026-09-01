'use strict';

// Gradescope scraper. No API exists, so the desktop app opens a real login
// window once (GT SSO + Duo), keeps the session in a persistent Electron
// partition, and scrapes HTML through that partition's cookie jar.
//
// Parsers here fail LOUDLY: a page that parses to zero rows while logged in
// throws and dumps the HTML to data/debug/ so the regex can be fixed against
// what Gradescope actually served — never a silent "0 assignments, all good".

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');

const PARTITION = 'persist:gradescope';
const BASE = 'https://www.gradescope.com';

function getSession() {
  let electron;
  try { electron = require('electron'); } catch {
    throw new Error('Gradescope sync only works inside the desktop app');
  }
  if (!electron.session) throw new Error('Gradescope sync only works inside the desktop app');
  return electron.session.fromPartition(PARTITION);
}

async function fetchPage(ses, url) {
  const res = await ses.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) school-tracker' },
    redirect: 'follow',
  });
  const html = await res.text();
  return { url: res.url, html, status: res.status };
}

const loggedOut = (page) =>
  /\/login\b/.test(page.url) || /name="session\[email\]"/.test(page.html);

function snapshot(name, html) {
  try {
    const file = path.join(db.DEBUG_DIR, `${name}-${Date.now()}.html`);
    fs.writeFileSync(file, html);
    return file;
  } catch { return null; }
}

const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/**
 * Dashboard → current-term course list. Gradescope renders terms as
 * `courseList--term` headings followed by a block of courseBox anchors; only
 * the first (most recent) term's courses are taken.
 */
function parseCourses(html) {
  const termHeads = [...html.matchAll(/courseList--term[^>]*>([^<]+)</g)]
    .map((m) => ({ term: strip(m[1]), index: m.index }));

  // Attribute order varies (`class` before `href` in current markup), so
  // match any courseBox anchor and dig the id out of its attributes.
  const boxes = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ attrs: m[1], inner: m[2], index: m.index }))
    .filter((b) => /class="[^"]*\bcourseBox\b/.test(b.attrs) && !/courseBox-new/.test(b.attrs))
    .map((b) => {
      const href = b.attrs.match(/href="\/courses\/(\d+)/);
      if (!href) return null;
      const short = b.inner.match(/courseBox--shortname[^>]*>([\s\S]*?)<\/(?:h\d|div|span)>/);
      const name = b.inner.match(/courseBox--name[^>]*>([\s\S]*?)<\/(?:h\d|div|span)>/);
      return {
        id: href[1],
        code: short ? strip(short[1]) : null,
        name: name ? strip(name[1]) : (short ? strip(short[1]) : `Course ${href[1]}`),
        index: b.index,
      };
    })
    .filter(Boolean);

  if (!termHeads.length) return { courses: boxes, term: null };

  const currentTerm = termHeads[0];
  const nextTermAt = termHeads.length > 1 ? termHeads[1].index : Infinity;
  return {
    courses: boxes.filter((b) => b.index > currentTerm.index && b.index < nextTermAt),
    term: currentTerm.term,
  };
}

/**
 * Course page → assignment rows out of #assignments-student-table.
 */
function parseAssignments(html, courseId) {
  const tableMatch = html.match(/<table[^>]*id="assignments-student-table"[\s\S]*?<\/table>/);
  if (!tableMatch) return { rows: null, hadTable: false };

  const rows = [];
  for (const tr of tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const rowHtml = tr[0];
    if (/<th[^>]*scope="col"/.test(rowHtml)) continue; // header row

    // Name: the primary <th> — linked while submissions are open, plain after.
    const th = rowHtml.match(/<th[\s\S]*?<\/th>/);
    if (!th) continue;
    const link = th[0].match(/href="(\/courses\/\d+\/assignments\/(\d+)[^"]*)"/);
    const name = strip(th[0]);
    if (!name) continue;

    const due = rowHtml.match(/submissionTimeChart--dueDate[^>]*datetime="([^"]+)"/);
    const statusCell = rowHtml.match(/submissionStatus[^>]*>([\s\S]*?)<\/(?:td|div)>/);
    const statusText = statusCell ? strip(statusCell[1]) : strip(rowHtml.replace(th[0], ''));

    let submitted = null;
    if (/no\s+submission/i.test(statusText)) submitted = 0;
    else if (/submitted|graded|late/i.test(statusText) || /\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?/.test(statusText)) submitted = 1;

    const assignmentId = link ? link[2] : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    rows.push({
      source: 'gradescope',
      source_id: `${courseId}:${assignmentId}`,
      courseKey: String(courseId),
      kind: /quiz|exam|midterm|final/i.test(name) ? 'quiz' : 'assignment',
      title: name,
      url: link ? `${BASE}${link[1]}` : `${BASE}/courses/${courseId}`,
      due_at: due ? (Date.parse(due[1]) || null) : null,
      submitted,
      raw: { status: statusText },
    });
  }
  return { rows, hadTable: true };
}

/**
 * → { courses, items, notes } | throws { expired: true } when the session died.
 */
async function fetchAll() {
  const ses = getSession();

  const dash = await fetchPage(ses, `${BASE}/`);
  if (loggedOut(dash)) {
    const err = new Error('Gradescope session expired — reconnect from Settings');
    err.expired = true;
    throw err;
  }

  const { courses: parsed, term } = parseCourses(dash.html);
  if (!parsed.length) {
    const file = snapshot('gradescope-dashboard', dash.html);
    throw new Error(`Gradescope markup changed: logged in but no courses parsed (HTML saved${file ? ` to ${path.basename(file)}` : ' failed'})`);
  }

  const courses = parsed.map((c) => ({
    source: 'gradescope',
    source_id: c.id,
    code: c.code,
    name: c.name,
    term,
    raw: null,
  }));

  const items = [];
  const notes = [];
  let failures = 0;

  for (const c of parsed) {
    try {
      const page = await fetchPage(ses, `${BASE}/courses/${c.id}`);
      if (loggedOut(page)) {
        const err = new Error('Gradescope session expired — reconnect from Settings');
        err.expired = true;
        throw err;
      }
      const { rows, hadTable } = parseAssignments(page.html, c.id);
      if (rows === null) {
        // Some course pages genuinely have no assignments table yet.
        notes.push(`${c.code || c.id}: no assignments table`);
        continue;
      }
      if (hadTable && !rows.length) {
        failures++;
        const file = snapshot(`gradescope-course-${c.id}`, page.html);
        notes.push(`${c.code || c.id}: table found but 0 rows parsed (HTML saved${file ? '' : ' failed'})`);
        continue;
      }
      items.push(...rows);
    } catch (err) {
      if (err.expired) throw err;
      failures++;
      notes.push(`${c.code || c.id}: ${err.message}`);
    }
  }

  if (failures && failures === parsed.length) {
    throw new Error(`Gradescope markup changed: every course page failed to parse (${notes.join('; ')})`);
  }

  return { courses, items, notes };
}

module.exports = { id: 'gradescope', label: 'Gradescope', fetchAll, PARTITION, parseCourses, parseAssignments };

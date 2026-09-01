'use strict';

const db = require('./db');
const secrets = require('./secrets');
const ai = require('./ai');
const sync = require('./sync');
const notify = require('./notify');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const KINDS = ['assignment', 'quiz', 'task', 'announcement'];

function gather() {
  const now = Date.now();
  const today0 = startOfDay(now);

  const groups = {
    overdue: db.listItems({ from: now - 14 * DAY, to: now, kinds: KINDS }),
    today: db.listItems({ from: now, to: today0 + DAY, kinds: KINDS }),
    tomorrow: db.listItems({ from: today0 + DAY, to: today0 + 2 * DAY, kinds: KINDS }),
    week: db.listItems({ from: today0 + 2 * DAY, to: today0 + 8 * DAY, kinds: KINDS }),
  };

  const fresh = db.db.prepare(
    `SELECT i.id, i.title, i.due_at, i.kind, i.source, c.code AS course_code
     FROM items i LEFT JOIN courses c ON c.id = i.course_id
     WHERE i.first_seen > ? AND i.hidden = 0 AND i.source != 'manual'
       AND i.duplicate_of IS NULL
       AND i.kind IN ('assignment', 'quiz')
     ORDER BY i.due_at IS NULL, i.due_at`
  ).all(now - DAY);

  const announcements = db.db.prepare(
    `SELECT i.id, i.title, i.url, i.due_at, i.first_seen, c.code AS course_code
     FROM items i LEFT JOIN courses c ON c.id = i.course_id
     WHERE i.kind = 'announcement' AND i.first_seen > ? AND i.hidden = 0
     ORDER BY i.first_seen DESC LIMIT 10`
  ).all(now - 2 * DAY);

  return { now, groups, fresh, announcements, report: sync.readReport() };
}

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const h = d.getHours() % 12 || 12;
  const ap = d.getHours() < 12 ? 'am' : 'pm';
  const min = d.getMinutes() ? `:${String(d.getMinutes()).padStart(2, '0')}` : '';
  return `${wd} ${d.getMonth() + 1}/${d.getDate()} ${h}${min}${ap}`;
};

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SOURCE_NAMES = { canvas: 'Canvas', gcal: 'Calendar', ed: 'Ed', gradescope: 'Gradescope', manual: 'Task' };

function rowHtml(i) {
  const course = i.course_code ? `<span style="color:#7a8699;font-size:12px">[${esc(i.course_code)}]</span> ` : '';
  const title = i.url ? `<a href="${esc(i.url)}" style="color:#dce3ec;text-decoration:none">${esc(i.title)}</a>` : esc(i.title);
  const badge = `<span style="color:#7a8699;font-size:11px"> · ${SOURCE_NAMES[i.source] || i.source}</span>`;
  const sub = i.submitted_any ? ' <span style="color:#4caf7d;font-size:11px">submitted ✓</span>' : '';
  const due = i.due_at ? `<span style="color:#9aa7b8;font-size:12px"> — ${fmtTime(i.due_at)}</span>` : '';
  const pts = i.points ? `<span style="color:#7a8699;font-size:11px"> · ${i.points}pt</span>` : '';
  return `<div style="padding:5px 0;border-bottom:1px solid #232a35">${course}${title}${due}${pts}${badge}${sub}</div>`;
}

function sectionHtml(label, items, color) {
  if (!items.length) return '';
  return `<div style="margin:18px 0 6px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${color}">${label} (${items.length})</div>` +
    items.map(rowHtml).join('');
}

function summaryText({ groups, fresh }) {
  const line = (i) => {
    const bits = [i.course_code ? `[${i.course_code}]` : '', i.title, i.due_at ? `due ${fmtTime(i.due_at)}` : '',
      i.points ? `${i.points}pt` : '', i.submitted_any ? 'already submitted' : ''];
    return '- ' + bits.filter(Boolean).join(' ');
  };
  const block = (label, items) => (items.length ? `${label}:\n${items.map(line).join('\n')}\n` : '');
  return (
    block('OVERDUE', groups.overdue) +
    block('DUE TODAY', groups.today) +
    block('DUE TOMORROW', groups.tomorrow) +
    block('THIS WEEK', groups.week) +
    block('NEWLY POSTED', fresh)
  ) || 'Nothing due today, tomorrow, or this week.';
}

function healthLine(report) {
  if (!report) return 'no sync has run yet';
  return report.sources
    .map((s) => `${s.label}: ${s.skipped ? 'not set up' : s.ok ? `${s.matched} items` : `FAILED (${s.error})`}`)
    .join(' · ');
}

async function build() {
  const data = gather();
  const { groups, fresh, announcements, report } = data;

  let brief = null;
  if (ai.claudeAvailable()) {
    try {
      brief = await ai.morningBrief(summaryText(data));
    } catch (err) {
      console.warn('[digest] brief skipped:', err.message);
    }
  }

  const d = new Date();
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
  const subject = `${weekday} — ${groups.today.length} due today, ${groups.overdue.length} overdue`;

  const annHtml = announcements.length
    ? `<div style="margin:18px 0 6px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#8a93e8">Recent announcements</div>` +
      announcements.map((a) =>
        `<div style="padding:5px 0;border-bottom:1px solid #232a35">${a.course_code ? `<span style="color:#7a8699;font-size:12px">[${esc(a.course_code)}]</span> ` : ''}` +
        `<a href="${esc(a.url)}" style="color:#dce3ec;text-decoration:none">${esc(a.title)}</a>` +
        `${a.due_at ? `<span style="color:#e8b04c;font-size:12px"> — deadline mentioned: <b>${fmtTime(a.due_at)}</b></span>` : ''}</div>`
      ).join('')
    : '';

  const html = `
<div style="background:#12161d;color:#dce3ec;font-family:Segoe UI,system-ui,sans-serif;padding:28px;max-width:640px;margin:0 auto;border-radius:8px">
  <div style="font-size:18px;font-weight:600">School Tracker — ${weekday} ${d.getMonth() + 1}/${d.getDate()}</div>
  ${brief ? `<div style="margin:14px 0;padding:12px 14px;background:#1a212c;border-left:3px solid #4c8fe8;border-radius:4px;font-size:14px;line-height:1.55">${esc(brief)}</div>` : ''}
  ${sectionHtml('Overdue', groups.overdue, '#e86c5c')}
  ${sectionHtml('Due today', groups.today, '#e8b04c')}
  ${sectionHtml('Due tomorrow', groups.tomorrow, '#dce3ec')}
  ${sectionHtml('This week', groups.week, '#9aa7b8')}
  ${sectionHtml('Newly posted (last 24h)', fresh, '#4caf7d')}
  ${annHtml}
  ${(!groups.overdue.length && !groups.today.length && !groups.tomorrow.length && !groups.week.length)
    ? '<div style="margin:18px 0;color:#9aa7b8">Nothing on the radar this week. Enjoy it.</div>' : ''}
  <div style="margin-top:24px;padding-top:10px;border-top:1px solid #232a35;font-size:11px;color:#7a8699">
    ${esc(healthLine(report))}
  </div>
</div>`;

  const text = (brief ? brief + '\n\n' : '') + summaryText(data) +
    '\n--\n' + healthLine(report);

  return { subject, html, text };
}

/** Send the digest to the user's own Gmail. Throws with a friendly message. */
async function send() {
  const address = db.getSetting('gmail_address', '');
  const password = secrets.getSecret('gmail_app_password');
  if (!address || !password) {
    throw new Error('digest needs a Gmail address and app password — set both in Settings');
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: address, pass: password },
  });

  const { subject, html, text } = await build();
  await transporter.sendMail({ from: address, to: address, subject, html, text });
  db.setSetting('last_digest_sent', String(Date.now()));
  return { subject };
}

module.exports = { build, send, gather };

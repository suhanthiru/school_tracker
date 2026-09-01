'use strict';

const db = require('./db');
const bridge = require('./bridge');

// Native toasts go out through main.js (bridge 'toast'); every toast is also
// kept in a small in-memory ring so the web UI can mirror them — if Windows
// suppresses notifications, nothing is lost.

const recent = [];

function localDate(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Fire a toast at most once per key, ever (the `notified` table remembers). */
function toastOnce(key, { title, body = '', route = null }) {
  if (db.wasNotified(key)) return false;
  db.markNotified(key);
  const toast = { key, title, body, route, at: Date.now() };
  recent.push(toast);
  if (recent.length > 50) recent.shift();
  bridge.emit('toast', toast);
  return true;
}

const HOUR = 3600 * 1000;

/**
 * Cheap SQL scan, called every scheduler tick: things due soon and not
 * handled get one 48h heads-up and one 24h warning, ever.
 */
function scanDeadlines() {
  const now = Date.now();
  const rows = db.db.prepare(
    `SELECT i.id, i.title, i.due_at, c.code AS course_code
     FROM items i LEFT JOIN courses c ON c.id = i.course_id
     WHERE i.due_at > ? AND i.due_at < ?
       AND i.status != 'done' AND i.hidden = 0
       AND i.duplicate_of IS NULL
       AND (i.submitted IS NULL OR i.submitted = 0)
       AND NOT EXISTS (SELECT 1 FROM items d WHERE d.duplicate_of = i.id AND d.submitted = 1)
       AND i.kind IN ('assignment', 'quiz', 'task')
       AND (c.id IS NULL OR c.hidden = 0)`
  ).all(now, now + 48 * HOUR);

  for (const r of rows) {
    const hoursLeft = Math.max(1, Math.round((r.due_at - now) / HOUR));
    const label = r.course_code ? `[${r.course_code}] ` : '';
    if (r.due_at < now + 24 * HOUR) {
      toastOnce(`deadline24:${r.id}`, {
        title: `Due in ${hoursLeft}h — not submitted`,
        body: `${label}${r.title}`,
        route: `#item-${r.id}`,
      });
    } else {
      toastOnce(`deadline48:${r.id}`, {
        title: 'Due in 2 days',
        body: `${label}${r.title}`,
        route: `#item-${r.id}`,
      });
    }
  }
}

/**
 * Newly-discovered work from a sync. Batched above 3 so onboarding a source
 * doesn't machine-gun the notification center.
 */
function newItems(sourceLabel, inserted) {
  const worthToasting = inserted.filter(
    (i) => (i.kind === 'assignment' || i.kind === 'quiz') && !db.wasNotified(`new:${i.id}`)
  );
  for (const i of worthToasting) db.markNotified(`new:${i.id}`);

  if (!worthToasting.length) return;
  if (worthToasting.length > 3) {
    bridge.emit('toast', {
      title: `${worthToasting.length} new assignments from ${sourceLabel}`,
      body: worthToasting.slice(0, 3).map((i) => i.title).join(' · ') + '…',
      route: '#radar',
      at: Date.now(),
    });
    return;
  }
  for (const i of worthToasting) {
    bridge.emit('toast', {
      title: `New on ${sourceLabel}`,
      body: i.title,
      route: `#item-${i.id}`,
      at: Date.now(),
    });
  }
}

function ssoExpired(label) {
  toastOnce(`sso-expired:${label}:${localDate()}`, {
    title: `${label} session expired`,
    body: 'Open Settings and click Reconnect to sign in again.',
    route: '#settings',
  });
}

const getRecent = () => recent.slice(-15).reverse();

module.exports = { toastOnce, scanDeadlines, newItems, ssoExpired, getRecent, localDate };

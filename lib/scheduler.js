'use strict';

const db = require('./db');
const sync = require('./sync');
const notify = require('./notify');
const digest = require('./digest');

// A 60-second tick instead of one long setInterval: both duties (sync cadence,
// digest time) are expressed as "is it due yet?" checks, so a laptop waking
// from sleep self-heals on the first tick instead of waiting a full interval.

let timer = null;

const localHHMM = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function tick() {
  const now = Date.now();

  try {
    const intervalMs = Math.max(5, Number(db.getSetting('sync_interval_min', '30')) || 30) * 60 * 1000;
    const last = sync.lastSyncAt() || 0;
    if (now - last >= intervalMs) {
      sync.sync().catch((err) => console.error('[sync]', err));
    }
  } catch (err) {
    console.error('[scheduler]', err);
  }

  try { maybeSendDigest(now); } catch (err) { console.error('[digest]', err); }
  try { notify.scanDeadlines(); } catch (err) { console.error('[deadlines]', err); }
}

function maybeSendDigest(now) {
  if (db.getSetting('digest_enabled', '1') !== '1') return;
  const today = notify.localDate(now);
  if (db.getSetting('last_digest_date') === today) return;
  // Zero-padded HH:MM strings compare correctly as strings.
  if (localHHMM(now) < db.getSetting('digest_time', '07:30')) return;

  // Mark BEFORE sending — a throwing send must never loop-spam the inbox.
  db.setSetting('last_digest_date', today);

  sync.sync()
    .catch(() => null) // digest still goes out on stale data if a source is down
    .then(() => digest.send())
    .then(({ subject }) => console.log('[digest] sent:', subject))
    .catch((err) => {
      console.error('[digest]', err.message);
      notify.toastOnce(`digest-fail:${today}`, {
        title: 'Morning digest failed',
        body: err.message,
        route: '#settings',
      });
    });
}

function start() {
  if (timer) return;
  db.pruneOld();
  tick(); // first sync at boot
  timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick };

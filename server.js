'use strict';

const express = require('express');
const path = require('node:path');

const db = require('./lib/db');
const secrets = require('./lib/secrets');
const sync = require('./lib/sync');
const ai = require('./lib/ai');
const notify = require('./lib/notify');
const digest = require('./lib/digest');
const dates = require('./lib/dates');
const bridge = require('./lib/bridge');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const ok = (res, body) => res.json(body);
  const fail = (res, err, code = 500) =>
    res.status(code).json({ error: err.message || String(err) });

  // ---------- meta ----------

  app.get('/api/meta', (req, res) => {
    try {
      ok(res, {
        lastSync: sync.lastSyncAt(),
        syncing: sync.isSyncing(),
        report: sync.readReport(),
        sources: sync.sourceStates(),
        gradescopeState: db.getSetting('gradescope_state', 'never'),
        canvasState: db.getSetting('canvas_state', 'never'),
        claude: ai.claudeAvailable(),
        aiQueue: ai.queueDepth(),
        stats: db.stats(),
        recentToasts: notify.getRecent(),
        statuses: db.STATUSES,
        settings: {
          sync_interval_min: Number(db.getSetting('sync_interval_min', '30')),
          digest_enabled: db.getSetting('digest_enabled', '1') === '1',
          digest_time: db.getSetting('digest_time', '07:30'),
          treat_submitted_as_done: db.getSetting('treat_submitted_as_done', '1') === '1',
          last_digest_date: db.getSetting('last_digest_date', null),
          onboarded: db.getSetting('onboarded', '0') === '1',
        },
      });
    } catch (err) { fail(res, err); }
  });

  // ---------- items ----------

  app.get('/api/items', (req, res) => {
    try {
      const num = (v) => (v === undefined || v === '' ? null : Number(v));
      ok(res, {
        items: db.listItems({
          from: num(req.query.from),
          to: num(req.query.to),
          q: req.query.q || '',
          course: num(req.query.course),
          source: req.query.source || '',
          includeDone: req.query.include_done === '1',
          kinds: req.query.kinds ? String(req.query.kinds).split(',') : null,
        }),
      });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/items', (req, res) => {
    try {
      const { title, due_at = null, course_id = null, notes = '', estimate_min = null } = req.body || {};
      if (!String(title || '').trim()) return fail(res, new Error('title is required'), 400);
      ok(res, db.createManualItem({
        title: String(title).trim(),
        due_at: due_at === null ? null : Number(due_at),
        course_id: course_id === null ? null : Number(course_id),
        notes: String(notes || ''),
        estimate_min: estimate_min === null ? null : Number(estimate_min),
      }));
    } catch (err) { fail(res, err); }
  });

  // Quick-capture: free text in, task out ("read ch 7 by fri 5pm").
  app.post('/api/capture', (req, res) => {
    try {
      const parsed = dates.parseCapture(String((req.body || {}).text || ''));
      if (!parsed.title) return fail(res, new Error('nothing to capture'), 400);
      ok(res, db.createManualItem({ title: parsed.title, due_at: parsed.due_at }));
    } catch (err) { fail(res, err); }
  });

  app.patch('/api/items/:id', (req, res) => {
    try {
      const item = db.updateItem(Number(req.params.id), req.body || {});
      if (!item) return fail(res, new Error('not found'), 404);
      ok(res, item);
    } catch (err) { fail(res, err, 400); }
  });

  app.delete('/api/items/:id', (req, res) => {
    try {
      if (!db.deleteManualItem(Number(req.params.id))) {
        return fail(res, new Error('only manual tasks can be deleted — synced items can be hidden'), 400);
      }
      ok(res, { deleted: true });
    } catch (err) { fail(res, err); }
  });

  // ---------- courses ----------

  app.get('/api/courses', (req, res) => {
    try { ok(res, { courses: db.listCourses({ includeHidden: req.query.all === '1' }) }); }
    catch (err) { fail(res, err); }
  });

  app.patch('/api/courses/:id', (req, res) => {
    try {
      if ((req.body || {}).hidden !== undefined) db.setCourseHidden(Number(req.params.id), !!req.body.hidden);
      ok(res, { updated: true });
    } catch (err) { fail(res, err); }
  });

  // ---------- planner blocks ----------

  app.get('/api/blocks', (req, res) => {
    try {
      const { from, to } = req.query;
      if (!from || !to) return fail(res, new Error('from and to (YYYY-MM-DD) are required'), 400);
      ok(res, { blocks: db.listBlocks({ from, to }) });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/blocks', (req, res) => {
    try { ok(res, db.createBlock(req.body || {})); }
    catch (err) { fail(res, err, 400); }
  });

  app.patch('/api/blocks/:id', (req, res) => {
    try {
      const block = db.updateBlock(Number(req.params.id), req.body || {});
      if (!block) return fail(res, new Error('not found'), 404);
      ok(res, block);
    } catch (err) { fail(res, err, 400); }
  });

  app.delete('/api/blocks/:id', (req, res) => {
    try { ok(res, { deleted: db.deleteBlock(Number(req.params.id)) }); }
    catch (err) { fail(res, err); }
  });

  // ---------- AI day planner ----------

  app.post('/api/planner/suggest', async (req, res) => {
    try {
      if (!ai.claudeAvailable()) return fail(res, new Error('the claude CLI is not installed'), 400);

      const dateStr = (req.body || {}).date || notify.localDate();
      const [y, m, d] = dateStr.split('-').map(Number);
      const dayStart = new Date(y, m - 1, d).getTime();
      const dayEnd = dayStart + 24 * 3600 * 1000;
      const now = Date.now();
      const isToday = dateStr === notify.localDate(now);

      const tasks = db.listItems({ kinds: ['assignment', 'quiz', 'task'] })
        .filter((i) => i.due_at === null || i.due_at < dayEnd + 7 * 24 * 3600 * 1000)
        .filter((i) => i.submitted !== true)
        .slice(0, 15)
        .map((i) => ({
          item_id: i.id,
          title: `${i.course_code ? `[${i.course_code}] ` : ''}${i.title}`,
          kind: i.kind,
          points: i.points,
          estimate_min: i.estimate_min,
          due: i.due_at ? new Date(i.due_at).toString().slice(0, 21) : null,
        }));
      if (!tasks.length) return fail(res, new Error('nothing undone to plan'), 400);

      const busy = db.db.prepare(
        `SELECT title, due_at, raw FROM items
         WHERE source = 'gcal' AND due_at >= ? AND due_at < ? AND all_day = 0 AND hidden = 0`
      ).all(dayStart, dayEnd).map((e) => {
        let end = null;
        try { end = JSON.parse(e.raw || '{}').end; } catch { /* no end */ }
        const startMin = Math.round((e.due_at - dayStart) / 60000);
        const durMin = end ? Math.max(15, Math.round((end - e.due_at) / 60000)) : 60;
        return { title: e.title, start_min: startMin, duration_min: durMin };
      });

      const planned = db.listBlocks({ from: dateStr, to: dateStr })
        .filter((b) => b.start_min !== null)
        .map((b) => ({ title: b.item_title || b.title, start_min: b.start_min, duration_min: b.duration_min }));

      const nowMin = isToday
        ? Math.round((now - dayStart) / 60000)
        : 8 * 60;

      const proposals = await ai.planDay({
        now, nowMin, dayStartMin: Math.max(7 * 60, nowMin), tasks, busy, planned,
      });

      const valid = new Set(tasks.map((t) => t.item_id));
      ok(res, {
        date: dateStr,
        proposals: proposals.filter((p) => p.item_id === null || valid.has(p.item_id)),
      });
    } catch (err) { fail(res, err); }
  });

  // ---------- sync ----------

  app.post('/api/sync', async (req, res) => {
    try { ok(res, await sync.sync(req.query.source || null)); }
    catch (err) { fail(res, err); }
  });

  // ---------- settings ----------

  const PLAIN_SETTINGS = [
    'canvas_base_url', 'ed_base_url', 'sync_interval_min', 'digest_enabled',
    'digest_time', 'gmail_address', 'treat_submitted_as_done', 'capture_hotkey',
    'onboarded',
  ];

  app.get('/api/settings', (req, res) => {
    try {
      const out = {};
      for (const k of PLAIN_SETTINGS) out[k] = db.getSetting(k, '');
      for (const k of secrets.SECRET_KEYS) out[`has_${k}`] = secrets.hasSecret(k);
      out.gradescope_state = db.getSetting('gradescope_state', 'never');
      out.canvas_state = db.getSetting('canvas_state', 'never');
      ok(res, out);
    } catch (err) { fail(res, err); }
  });

  app.put('/api/settings', (req, res) => {
    try {
      const body = req.body || {};
      for (const k of PLAIN_SETTINGS) {
        if (body[k] !== undefined) db.setSetting(k, String(body[k]));
      }
      for (const k of secrets.SECRET_KEYS) {
        // Empty string means "leave unchanged"; null clears.
        if (body[k] === null) secrets.setSecret(k, '');
        else if (typeof body[k] === 'string' && body[k].trim()) secrets.setSecret(k, body[k]);
      }
      if (body.capture_hotkey !== undefined) bridge.emit('hotkey-changed');
      ok(res, { saved: true });
    } catch (err) { fail(res, err); }
  });

  // One live read-only call per source so a bad token is caught at paste time.
  app.post('/api/settings/test/:source', async (req, res) => {
    const source = req.params.source;
    try {
      if (source === 'canvas') {
        const token = secrets.getSecret('canvas_token');
        if (!token && db.getSetting('canvas_state', 'never') === 'never') {
          throw new Error('paste a token or use "Connect with school login" first');
        }
        const canvasAdapter = require('./lib/sources/canvas');
        const user = await canvasAdapter.whoami({
          baseUrl: db.getSetting('canvas_base_url'), token,
        });
        return ok(res, { ok: true, detail: `authenticated as ${user.name || user.id}${token ? '' : ' (school login)'}` });
      }
      if (source === 'gcal') {
        const url = secrets.getSecret('gcal_ics_url');
        if (!url) throw new Error('paste the secret iCal address first');
        const r = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
        const text = await r.text();
        if (!/^\s*BEGIN:VCALENDAR/.test(text)) throw new Error('that URL is not an iCal feed');
        const name = text.match(/X-WR-CALNAME:(.+)/);
        const count = (text.match(/BEGIN:VEVENT/g) || []).length;
        return ok(res, { ok: true, detail: `calendar "${name ? name[1].trim() : 'unnamed'}", ${count} events in feed` });
      }
      if (source === 'ed') {
        const base = String(db.getSetting('ed_base_url', '')).replace(/\/+$/, '');
        const token = secrets.getSecret('ed_token');
        if (!token) throw new Error('paste an Ed token first');
        const r = await fetch(`${base}/user`, {
          headers: { 'X-Token': token, Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'token rejected' : `HTTP ${r.status}`);
        const body = await r.json();
        const n = Array.isArray(body.courses) ? body.courses.length : 0;
        return ok(res, { ok: true, detail: `authenticated as ${body.user ? body.user.name : '?'} — ${n} courses` });
      }
      if (source === 'gradescope') {
        const report = await sync.syncOne('gradescope');
        const health = (report.sources || []).find((s) => s.id === 'gradescope');
        if (!health || health.skipped) throw new Error('connect Gradescope first');
        if (!health.ok) throw new Error(health.error || 'sync failed');
        return ok(res, { ok: true, detail: `${health.matched} assignments across the current term` });
      }
      throw new Error(`unknown source ${source}`);
    } catch (err) {
      ok(res, { ok: false, detail: err.message });
    }
  });

  // ---------- SSO sessions (gradescope, canvas) ----------

  const SSO = { gradescope: 'gradescope_state', canvas: 'canvas_state' };

  app.post('/api/sso/:service/connect', (req, res) => {
    if (!SSO[req.params.service]) return fail(res, new Error('unknown service'), 400);
    bridge.emit('sso-login', req.params.service);
    ok(res, { opening: true });
  });

  app.post('/api/sso/:service/disconnect', (req, res) => {
    const stateKey = SSO[req.params.service];
    if (!stateKey) return fail(res, new Error('unknown service'), 400);
    bridge.emit('sso-logout', req.params.service);
    db.setSetting(stateKey, 'never');
    ok(res, { disconnected: true });
  });

  // Graceful shutdown (loopback-only server, so this is local by definition).
  // A force-killed Electron can lose freshly-written session cookies; this
  // path flushes them properly.
  app.post('/api/quit', (req, res) => {
    ok(res, { quitting: true });
    setTimeout(() => bridge.emit('quit'), 150);
  });

  // ---------- syllabus ----------

  const syllabus = require('./lib/syllabus');

  app.post('/api/syllabus/import', async (req, res) => {
    try {
      const { text, course_id = null } = req.body || {};
      ok(res, await syllabus.importText(text, course_id ? Number(course_id) : null));
    } catch (err) { fail(res, err, 400); }
  });

  // Desktop only: opens a native file dialog; result arrives as a toast.
  app.post('/api/syllabus/pick', (req, res) => {
    const { course_id = null } = req.body || {};
    syllabus.pickAndImport(course_id ? Number(course_id) : null);
    ok(res, { picking: true });
  });

  // ---------- digest ----------

  app.post('/api/digest/send', async (req, res) => {
    try { ok(res, await digest.send()); }
    catch (err) { fail(res, err, 400); }
  });

  app.get('/api/digest/preview', async (req, res) => {
    try {
      const { subject, html } = await digest.build();
      res.set('Content-Type', 'text/html').send(`<!doctype html><title>${subject}</title><body style="margin:0;background:#0c0f14">${html}</body>`);
    } catch (err) { fail(res, err); }
  });

  return app;
}

function start(port = 0) {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const server = app.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

module.exports = { createApp, start };

if (require.main === module) {
  const port = Number(process.env.PORT || 4747);
  start(port).then(() => {
    console.log(`school-tracker API on http://127.0.0.1:${port}`);
    require('./lib/scheduler').start();
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

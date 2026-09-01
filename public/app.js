'use strict';

// Shared state + plumbing. Each view module registers itself on App.views.

const App = {
  items: [],
  courses: [],
  meta: null,
  tab: 'radar',
  views: {},

  $(sel, root = document) { return root.querySelector(sel); },
  $$(sel, root = document) { return [...root.querySelectorAll(sel)]; },

  async api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  },

  esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // ---------- time helpers ----------

  DAY: 24 * 3600 * 1000,

  startOfDay(ts = Date.now()) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  },

  localISO(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  fmtDue(ts, allDay) {
    if (!ts) return '';
    const now = Date.now();
    const d = new Date(ts);
    const today0 = App.startOfDay(now);
    const day0 = App.startOfDay(ts);
    const time = allDay ? '' : `${d.getHours() % 12 || 12}${d.getMinutes() ? ':' + String(d.getMinutes()).padStart(2, '0') : ''}${d.getHours() < 12 ? 'am' : 'pm'}`;
    const days = Math.round((day0 - today0) / App.DAY);
    if (days === 0) return `today ${time}`.trim();
    if (days === 1) return `tomorrow ${time}`.trim();
    if (days === -1) return `yesterday ${time}`.trim();
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    if (days > 1 && days < 7) return `${wd} ${time}`.trim();
    return `${wd} ${d.getMonth() + 1}/${d.getDate()} ${time}`.trim();
  },

  timeAgo(ts) {
    if (!ts) return 'never';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (m < 36 * 60) return `${Math.round(m / 60)}h ago`;
    return `${Math.round(m / 60 / 24)}d ago`;
  },

  sourceName(s) {
    return { canvas: 'Canvas', gcal: 'Calendar', ed: 'Ed', gradescope: 'Gradescope', manual: 'manual', syllabus: 'syllabus' }[s] || s;
  },

  // ---------- urgency ----------

  urgency(item) {
    if (!item.due_at || item.status === 'done') return -1;
    const hours = (item.due_at - Date.now()) / 3600000;
    if (item.submitted_any) return -1;
    let score = 0;
    if (hours < 0) score += 55 + Math.max(-20, hours / 24);       // overdue, decaying
    else score += Math.max(0, 48 - hours) * 1.6;                  // proximity ramp
    score += Math.min(20, (item.points || 0) * 0.4);              // point weight
    if (item.kind === 'quiz') score += 6;
    if (/exam|midterm|final/i.test(item.title)) score += 14;
    if (item.status === 'in_progress') score -= 4;                // already moving
    return score;
  },

  // ---------- data ----------

  async refresh() {
    const [items, courses, meta] = await Promise.all([
      App.api('/api/items?include_done=1'),
      App.api('/api/courses'),
      App.api('/api/meta'),
    ]);
    App.items = items.items;
    App.courses = courses.courses;
    App.meta = meta;
    App.renderChrome();
    App.renderTab();
  },

  async refreshMeta() {
    App.meta = await App.api('/api/meta');
    App.renderChrome();
  },

  // ---------- chrome ----------

  renderChrome() {
    const meta = App.meta;
    if (!meta) return;

    App.$('#last-sync').textContent = meta.syncing ? 'syncing…' : `synced ${App.timeAgo(meta.lastSync)}`;

    const strip = App.$('#health-strip');
    const report = meta.report;
    strip.innerHTML = (meta.sources || []).map((s) => {
      const h = report && report.sources.find((r) => r.id === s.id);
      if (!s.enabled) return `<span class="health-chip" title="not set up">${s.label}</span>`;
      if (!h || h.skipped) return `<span class="health-chip" title="waiting for first sync">${s.label}</span>`;
      if (h.ok) return `<span class="health-chip ok" title="${App.esc((h.notes || []).join('; ') || 'ok')}">${s.label} ${h.matched}</span>`;
      return `<span class="health-chip err" title="${App.esc(h.error || '')}">${s.label} ✗</span>`;
    }).join('');

    const toasts = meta.recentToasts || [];
    App.$('#toast-strip').innerHTML = toasts
      .filter((t) => Date.now() - t.at < 20000)
      .slice(0, 3)
      .map((t) => `<div class="toast"><div class="t-title">${App.esc(t.title)}</div>${t.body ? `<div class="t-body">${App.esc(t.body)}</div>` : ''}</div>`)
      .join('');
  },

  // ---------- tabs & routing ----------

  setTab(tab) {
    App.tab = tab;
    App.$$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    for (const name of ['radar', 'week', 'planner']) {
      App.$(`#view-${name}`).classList.toggle('hidden', name !== tab);
    }
    App.renderTab();
  },

  renderTab() {
    const view = App.views[App.tab];
    if (view) view.render();
  },

  handleHash() {
    const hash = location.hash.slice(1);
    if (!hash) return;
    if (hash === 'settings') { Settings.open(); return; }
    if (hash.startsWith('item-')) {
      App.setTab('radar');
      setTimeout(() => {
        const row = document.getElementById(hash);
        if (row) {
          row.scrollIntoView({ block: 'center', behavior: 'smooth' });
          row.classList.add('flash');
          setTimeout(() => row.classList.remove('flash'), 2500);
        }
      }, 150);
      return;
    }
    if (App.views[hash]) App.setTab(hash);
  },

  // ---------- boot ----------

  async boot() {
    App.$$('#tabs .tab').forEach((b) =>
      b.addEventListener('click', () => { location.hash = b.dataset.tab; }));

    App.$('#sync-now').addEventListener('click', async () => {
      const btn = App.$('#sync-now');
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      try { await App.api('/api/sync', { method: 'POST' }); await App.refresh(); }
      catch (err) { alert(err.message); }
      finally { btn.disabled = false; btn.textContent = 'Sync'; }
    });

    App.$('#open-settings').addEventListener('click', () => Settings.open());
    App.$('#close-settings').addEventListener('click', () => Settings.close());

    window.addEventListener('hashchange', App.handleHash);

    await App.refresh();
    App.handleHash();

    if (App.meta && !App.meta.settings.onboarded) Settings.openOnboarding();

    setInterval(() => App.refreshMeta().catch(() => {}), 15000);
    setInterval(() => { if (App.tab !== 'planner') App.refresh().catch(() => {}); }, 60000);
  },
};

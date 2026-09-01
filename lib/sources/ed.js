'use strict';

// Ed Discussions adapter. The API is undocumented but stable enough that
// several community clients rely on it. Treated as enrichment (announcements),
// never as the source of record — a failure here degrades to "no
// announcements", it must not block Canvas.
//
// Token from edstem.org → Settings → API Tokens.

function headers(token) {
  // The web client sends X-Token; API clients send a Bearer header. Send both.
  return {
    'X-Token': token,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'school-tracker',
  };
}

async function getJson(url, token) {
  const res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(60000) });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Ed token rejected — create a new one at edstem.org → Settings → API Tokens');
  }
  if (!res.ok) throw new Error(`Ed HTTP ${res.status}`);
  return res.json();
}

const THREADS_PER_COURSE = 40;

/**
 * ctx: { baseUrl, token }
 * → { courses, items, notes }
 */
async function fetchAll(ctx) {
  const base = String(ctx.baseUrl || 'https://us.edstem.org/api').replace(/\/+$/, '');
  if (!ctx.token) throw new Error('no Ed token');

  const user = await getJson(`${base}/user`, ctx.token);
  const enrollments = Array.isArray(user.courses) ? user.courses : [];

  const active = enrollments
    .map((e) => e.course || e)
    .filter((c) => c && c.id && (c.status ? c.status === 'active' : true));

  const courses = active.map((c) => ({
    source: 'ed',
    source_id: String(c.id),
    code: c.code || null,
    name: c.name || c.code || `Ed course ${c.id}`,
    term: [c.session, c.year].filter(Boolean).join(' ') || null,
    raw: c,
  }));

  const items = [];
  const notes = [];

  for (const c of active) {
    let threads;
    try {
      const body = await getJson(
        `${base}/courses/${c.id}/threads?limit=${THREADS_PER_COURSE}&sort=new`,
        ctx.token
      );
      threads = Array.isArray(body.threads) ? body.threads : [];
    } catch (err) {
      notes.push(`${c.code || c.id}: ${err.message}`);
      continue;
    }

    for (const t of threads) {
      if (!t || !t.id) continue;
      const isAnnouncement = t.type === 'announcement' || t.is_announced || t.is_pinned;
      if (!isAnnouncement) continue;
      items.push({
        source: 'ed',
        source_id: `thread:${t.id}`,
        courseKey: String(c.id),
        kind: 'announcement',
        title: t.title || '(untitled announcement)',
        url: `https://edstem.org/us/courses/${c.id}/discussion/${t.id}`,
        due_at: null,
        preserveDue: true, // extraction owns the date; a re-sync must not clear it
        raw: { type: t.type, created_at: t.created_at, is_pinned: t.is_pinned },
        // Plain-text body, used only by the extraction pipeline (not stored raw).
        document: String(t.document || '').slice(0, 6000),
      });
    }
  }

  // A token that authenticates but sees zero courses is almost certainly the
  // wrong region — surface it instead of reporting a healthy empty sync.
  if (!courses.length) {
    notes.push('Ed returned no courses — if you have some, the Ed region/base URL is probably wrong');
  }

  return { courses, items, notes };
}

module.exports = { id: 'ed', label: 'Ed Discussions', fetchAll };

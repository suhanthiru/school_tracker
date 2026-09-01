'use strict';

// Radar: everything with (or without) a deadline, grouped by proximity, with a
// computed urgency score highlighting the top three "do this next" items.

App.views.radar = {
  showDone: false,
  filterCourse: '',
  filterSource: '',
  query: '',

  render() {
    const root = App.$('#view-radar');
    const v = App.views.radar;
    const now = Date.now();
    const today0 = App.startOfDay(now);
    const treatSubmitted = App.meta && App.meta.settings.treat_submitted_as_done;

    let items = App.items.filter((i) => i.kind !== 'event' && i.kind !== 'announcement');
    const announcements = App.items.filter((i) => i.kind === 'announcement');

    if (v.filterCourse) items = items.filter((i) => String(i.course_id) === v.filterCourse);
    if (v.filterSource) items = items.filter((i) => i.source === v.filterSource);
    if (v.query) {
      const q = v.query.toLowerCase();
      items = items.filter((i) => i.title.toLowerCase().includes(q));
    }

    const isDone = (i) => i.status === 'done' || (treatSubmitted && i.submitted === true);
    const active = items.filter((i) => !isDone(i));
    const doneItems = items.filter(isDone);

    // Top-3 urgency among active items.
    const ranked = [...active].map((i) => [App.urgency(i), i.id])
      .filter(([s]) => s > 25).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, id]) => id);
    const nextUp = new Set(ranked);

    const groups = [
      { key: 'overdue', label: 'Overdue', cls: 'overdue', test: (i) => i.due_at && i.due_at < now },
      { key: 'today', label: 'Due today', cls: 'today', test: (i) => i.due_at && i.due_at >= now && i.due_at < today0 + App.DAY },
      { key: 'tomorrow', label: 'Due tomorrow', cls: '', test: (i) => i.due_at >= today0 + App.DAY && i.due_at < today0 + 2 * App.DAY },
      { key: 'week', label: 'This week', cls: '', test: (i) => i.due_at >= today0 + 2 * App.DAY && i.due_at < today0 + 8 * App.DAY },
      { key: 'nextweek', label: 'Next week', cls: '', test: (i) => i.due_at >= today0 + 8 * App.DAY && i.due_at < today0 + 15 * App.DAY },
    ];
    const later = active.filter((i) => i.due_at >= today0 + 15 * App.DAY)
      .sort((a, b) => a.due_at - b.due_at);
    const undated = active.filter((i) => !i.due_at);

    let html = `
      <div id="quickbar">
        <input id="quick-add" placeholder='Add a task — try "finish lab report by fri 5pm"' autocomplete="off">
        <div id="radar-filters">
          <select id="f-course"><option value="">all courses</option>${
            App.courses.map((c) => `<option value="${c.id}" ${String(c.id) === v.filterCourse ? 'selected' : ''}>${App.esc(c.code || c.name)}</option>`).join('')
          }</select>
          <select id="f-source"><option value="">all sources</option>${
            ['canvas', 'gradescope', 'ed', 'gcal', 'syllabus', 'manual'].map((s) => `<option value="${s}" ${s === v.filterSource ? 'selected' : ''}>${App.sourceName(s)}</option>`).join('')
          }</select>
          <input id="f-q" placeholder="filter…" value="${App.esc(v.query)}" style="width:110px">
          <label class="check"><input type="checkbox" id="f-done" ${v.showDone ? 'checked' : ''}> done</label>
          <button class="btn" id="open-syllabus" title="import a course syllabus">📄 Syllabus</button>
        </div>
      </div>`;

    let any = false;
    for (const g of groups) {
      const rows = active.filter(g.test);
      if (!rows.length) continue;
      any = true;
      html += `<div class="group-head ${g.cls}">${g.label} <span class="count">${rows.length}</span></div>`;
      html += rows.map((i) => App.views.radar.rowHtml(i, nextUp)).join('');
    }

    // Everything beyond two weeks stays out of the way: one collapsed section,
    // structured by month, so the radar reads as "now", not "the semester".
    if (later.length) {
      any = true;
      const months = [];
      for (const i of later) {
        const d = new Date(i.due_at);
        const label = d.toLocaleDateString(undefined, { month: 'long', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
        if (!months.length || months[months.length - 1].label !== label) months.push({ label, items: [] });
        months[months.length - 1].items.push(i);
      }
      html += `<details class="later-rail"><summary>Later <span class="count">${later.length} items, ${App.esc(months[0].label)}–${App.esc(months[months.length - 1].label)}</span></summary>`;
      for (const m of months) {
        html += `<div class="group-head sub">${App.esc(m.label)} <span class="count">${m.items.length}</span></div>`;
        html += m.items.map((i) => App.views.radar.rowHtml(i, nextUp)).join('');
      }
      html += '</details>';
    }

    if (undated.length) {
      any = true;
      if (undated.length > 5) {
        html += `<details class="later-rail"><summary>No date <span class="count">${undated.length}</span></summary>`;
        html += undated.map((i) => App.views.radar.rowHtml(i, nextUp)).join('');
        html += '</details>';
      } else {
        html += `<div class="group-head">No date <span class="count">${undated.length}</span></div>`;
        html += undated.map((i) => App.views.radar.rowHtml(i, nextUp)).join('');
      }
    }

    if (!any) {
      html += `<div class="empty-note">Radar clear. ${App.meta && App.meta.sources.some((s) => s.enabled) ? 'Nothing needs you right now.' : 'Open Settings (⚙) to connect Canvas and the rest.'}</div>`;
    }

    if (v.showDone && doneItems.length) {
      html += `<div class="group-head">Done / submitted <span class="count">${doneItems.length}</span></div>`;
      html += doneItems.slice(0, 60).map((i) => App.views.radar.rowHtml(i, nextUp, true)).join('');
    }

    if (announcements.length) {
      const dated = announcements.filter((a) => a.due_at);
      const undated = announcements.filter((a) => !a.due_at);
      html += `<details id="ann-rail" ${dated.length ? 'open' : ''}>
        <summary>Announcements (${announcements.length})</summary>
        ${[...dated, ...undated].slice(0, 25).map((a) => `
          <div class="ann-row">
            ${a.course_code ? `<span class="chip course">${App.esc(a.course_code)}</span> ` : ''}
            <a href="${App.esc(a.url || '#')}" target="_blank">${App.esc(a.title)}</a>
            ${a.due_at ? ` — <b>deadline: ${App.fmtDue(a.due_at)}</b>${a.ai_method === 'claude' ? ' <span class="faint">(AI-read)</span>' : ''}` : ''}
          </div>`).join('')}
      </details>`;
    }

    root.innerHTML = html;
    App.views.radar.wire(root);
  },

  rowHtml(i, nextUp, muted = false) {
    const dueCls = !i.due_at ? '' : i.due_at < Date.now() ? 'past' : i.due_at < Date.now() + 36 * 3600000 ? 'soon' : '';
    const est = i.estimate_min ? `${i.estimate_min >= 60 ? (i.estimate_min / 60).toFixed(i.estimate_min % 60 ? 1 : 0) + 'h' : i.estimate_min + 'm'}` : '~';
    return `
    <div class="item-row ${muted ? 'done-row' : ''} ${nextUp.has(i.id) ? 'next-up' : ''}" id="item-${i.id}" data-id="${i.id}">
      <button class="status-btn ${i.status}" data-act="status" title="${i.status.replace('_', ' ')} — click to advance"></button>
      ${nextUp.has(i.id) ? '<span class="next-chip">NEXT</span>' : ''}
      <span class="i-title">${i.url ? `<a href="${App.esc(i.url)}" target="_blank">${App.esc(i.title)}</a>` : App.esc(i.title)}</span>
      ${i.course_code ? `<span class="chip course">${App.esc(i.course_code)}</span>` : ''}
      <span class="chip src-${i.source}">${App.sourceName(i.source)}</span>
      ${i.kind === 'quiz' ? '<span class="chip">quiz</span>' : ''}
      ${i.points ? `<span class="chip pts">${i.points}pt</span>` : ''}
      ${i.submitted === true ? '<span class="chip submitted">submitted ✓</span>' : ''}
      <span class="chip est" data-act="estimate" title="time estimate — feeds Plan my day">${est}</span>
      <span class="i-due ${dueCls}">${App.fmtDue(i.due_at, i.all_day)}</span>
      ${i.url ? `<a class="row-link" href="${App.esc(i.url)}" target="_blank" title="open the assignment">↗</a>` : '<span class="row-link-gap"></span>'}
      <button class="row-x" data-act="remove" title="${i.source === 'manual' ? 'delete task' : 'hide from radar'}">✕</button>
    </div>`;
  },

  wire(root) {
    const v = App.views.radar;

    const quick = App.$('#quick-add', root);
    quick.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !quick.value.trim()) return;
      try {
        await App.api('/api/capture', { method: 'POST', body: { text: quick.value.trim() } });
        quick.value = '';
        await App.refresh();
      } catch (err) { alert(err.message); }
    });

    App.$('#open-syllabus', root).addEventListener('click', () => Syllabus.open());
    App.$('#f-course', root).addEventListener('change', (e) => { v.filterCourse = e.target.value; v.render(); });
    App.$('#f-source', root).addEventListener('change', (e) => { v.filterSource = e.target.value; v.render(); });
    App.$('#f-done', root).addEventListener('change', (e) => { v.showDone = e.target.checked; v.render(); });
    App.$('#f-q', root).addEventListener('input', (e) => {
      v.query = e.target.value;
      clearTimeout(v._qt);
      v._qt = setTimeout(() => v.render(), 220);
    });

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const row = e.target.closest('.item-row');
      const id = Number(row.dataset.id);
      const item = App.items.find((i) => i.id === id);
      if (!item) return;

      try {
        if (btn.dataset.act === 'status') {
          const next = { not_started: 'in_progress', in_progress: 'done', done: 'not_started' }[item.status];
          Object.assign(item, await App.api(`/api/items/${id}`, { method: 'PATCH', body: { status: next } }));
          App.refreshMeta().catch(() => {});
          v.render();
        } else if (btn.dataset.act === 'estimate') {
          const cur = item.estimate_min || '';
          const input = prompt('Estimated minutes of work (blank to clear):', cur);
          if (input === null) return;
          const val = input.trim() === '' ? null : Number(input);
          Object.assign(item, await App.api(`/api/items/${id}`, { method: 'PATCH', body: { estimate_min: val } }));
          v.render();
        } else if (btn.dataset.act === 'remove') {
          if (item.source === 'manual') {
            await App.api(`/api/items/${id}`, { method: 'DELETE' });
            App.items = App.items.filter((i) => i.id !== id);
          } else {
            Object.assign(item, await App.api(`/api/items/${id}`, { method: 'PATCH', body: { hidden: true } }));
            App.items = App.items.filter((i) => i.id !== id);
          }
          v.render();
        }
      } catch (err) { alert(err.message); }
    });
  },
};

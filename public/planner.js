'use strict';

// Day planner: drag tasks from the rail onto a day/timeslot to time-block the
// week. Calendar events render as immovable "busy" texture so free time is
// honest. "Plan my day" asks the local claude CLI for a proposed schedule,
// shown as dashed ghosts until accepted.

App.views.planner = {
  offset: 0,
  blocks: [],
  proposals: [],
  proposalDate: null,

  START_MIN: 7 * 60,
  PX_PER_MIN: 0.8,

  weekStart() {
    const now = new Date();
    const day = (now.getDay() + 6) % 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + App.views.planner.offset * 7).getTime();
  },

  render() {
    const v = App.views.planner;
    v.load().catch((err) => { App.$('#view-planner').innerHTML = `<div class="empty-note">${App.esc(err.message)}</div>`; });
  },

  async load() {
    const v = App.views.planner;
    const start = v.weekStart();
    const res = await App.api(`/api/blocks?from=${App.localISO(start)}&to=${App.localISO(start + 6 * App.DAY)}`);
    v.blocks = res.blocks;
    v.draw();
  },

  yToMin(e, colBody) {
    const v = App.views.planner;
    const rect = colBody.getBoundingClientRect();
    const min = v.START_MIN + (e.clientY - rect.top) / v.PX_PER_MIN;
    return Math.max(v.START_MIN, Math.min(23 * 60 + 30, Math.round(min / 30) * 30));
  },

  draw() {
    const v = App.views.planner;
    const root = App.$('#view-planner');
    const start = v.weekStart();
    const todayISO = App.localISO(Date.now());

    // Rail: undone work, most urgent first.
    const rail = App.items
      .filter((i) => ['assignment', 'quiz', 'task'].includes(i.kind))
      .filter((i) => i.status !== 'done' && !i.submitted_any)
      .sort((a, b) => App.urgency(b) - App.urgency(a))
      .slice(0, 40);

    const startD = new Date(start);
    const title = `${startD.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} week`;
    const gridHeight = (24 * 60 - v.START_MIN) * v.PX_PER_MIN;

    let html = `
    <div id="planner-wrap">
      <div id="planner-rail">
        <div class="rail-head">Drag onto a day</div>
        ${rail.map((i) => `
          <div class="rail-item" draggable="true" data-drag='${App.esc(JSON.stringify({ type: 'item', id: i.id }))}'>
            ${App.esc(i.title)}${i.url ? ` <a class="row-link" href="${App.esc(i.url)}" target="_blank" title="open the assignment">↗</a>` : ''}
            <div class="r-meta">${[i.course_code, i.due_at ? 'due ' + App.fmtDue(i.due_at, i.all_day) : null, i.estimate_min ? i.estimate_min + 'm' : null].filter(Boolean).join(' · ')}</div>
          </div>`).join('') || '<div class="faint" style="font-size:12px">Nothing undone — enjoy.</div>'}
      </div>
      <div id="planner-main">
        <div id="planner-toolbar">
          <button class="btn" id="pl-prev">◀</button>
          <span class="cal-title">${title}</span>
          <button class="btn" id="pl-next">▶</button>
          ${v.offset !== 0 ? '<button class="btn ghost" id="pl-today">this week</button>' : ''}
          <div class="spacer" style="flex:1"></div>
          ${v.proposals.length ? `
            <span class="dim" style="font-size:12px">${v.proposals.length} proposed</span>
            <button class="btn primary" id="pl-accept">Accept all</button>
            <button class="btn" id="pl-dismiss">Dismiss</button>` : `
            <button class="btn primary" id="pl-plan" ${App.meta && App.meta.claude ? '' : 'disabled title="install the claude CLI to enable AI planning"'}>✦ Plan my day</button>`}
        </div>
        <div id="plan-grid">
          <div></div>
          ${[0, 1, 2, 3, 4, 5, 6].map((d) => {
            const iso = App.localISO(start + d * App.DAY);
            return `<div class="pg-col-head ${iso === todayISO ? 'today' : ''}">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]} ${new Date(start + d * App.DAY).getDate()}</div>`;
          }).join('')}
          <div></div>
          ${[0, 1, 2, 3, 4, 5, 6].map((d) => {
            const iso = App.localISO(start + d * App.DAY);
            const trayBlocks = v.blocks.filter((b) => b.date === iso && b.start_min === null);
            return `<div class="pg-daystrip" data-date="${iso}" data-tray="1" title="all-day tray — drop here for 'sometime that day'">
              ${trayBlocks.map((b) => v.trayBlockHtml(b)).join('')}
            </div>`;
          }).join('')}
          <div class="pg-times" style="height:${gridHeight}px">
            ${Array.from({ length: 24 - v.START_MIN / 60 }, (_, i) => {
              const h = v.START_MIN / 60 + i;
              return `<div class="pg-time-label" style="top:${(h * 60 - v.START_MIN) * v.PX_PER_MIN}px">${h % 12 || 12}${h < 12 ? 'a' : 'p'}</div>`;
            }).join('')}
          </div>
          ${[0, 1, 2, 3, 4, 5, 6].map((d) => v.columnHtml(start, d, gridHeight, todayISO)).join('')}
        </div>
      </div>
    </div>`;

    root.innerHTML = html;
    v.wire(root);
  },

  columnHtml(start, d, gridHeight, todayISO) {
    const v = App.views.planner;
    const iso = App.localISO(start + d * App.DAY);
    const dayStart = start + d * App.DAY;
    const dayEnd = dayStart + App.DAY;

    const busy = App.items.filter((i) =>
      i.source === 'gcal' && !i.all_day && i.due_at >= dayStart && i.due_at < dayEnd);

    const blocks = v.blocks.filter((b) => b.date === iso && b.start_min !== null);
    const ghosts = (v.proposalDate === iso) ? v.proposals : [];

    const pos = (min) => (min - v.START_MIN) * v.PX_PER_MIN;

    return `<div class="pg-col" data-date="${iso}" style="height:${gridHeight}px">
      ${Array.from({ length: 24 - v.START_MIN / 60 - 1 }, (_, i) =>
        `<div class="pg-hourline" style="top:${((i + 1) * 60) * v.PX_PER_MIN}px"></div>`).join('')}
      ${busy.map((e) => {
        const startMin = Math.round((e.due_at - dayStart) / 60000);
        const durMin = e.end_at ? Math.max(20, Math.round((e.end_at - e.due_at) / 60000)) : 60;
        if (startMin + durMin < v.START_MIN) return '';
        const top = pos(Math.max(v.START_MIN, startMin));
        const h = (Math.min(24 * 60, startMin + durMin) - Math.max(v.START_MIN, startMin)) * v.PX_PER_MIN;
        return `<div class="pg-busy" style="top:${top}px;height:${h}px" title="${App.esc(e.title)}">${App.esc(e.title)}</div>`;
      }).join('')}
      ${blocks.map((b) => {
        const title = b.item_title || b.title || '(removed task)';
        const done = b.done || b.item_status === 'done';
        return `<div class="pg-block ${done ? 'done' : ''}" draggable="true"
            data-drag='${App.esc(JSON.stringify({ type: 'block', id: b.id }))}' data-block="${b.id}"
            style="top:${pos(b.start_min)}px;height:${Math.max(20, b.duration_min * v.PX_PER_MIN)}px">
          <div class="b-title">${App.esc(title)}</div>
          <div class="b-meta">
            <input type="checkbox" data-check="${b.id}" ${done ? 'checked' : ''} title="done">
            ${b.course_code ? App.esc(b.course_code) + ' · ' : ''}${b.duration_min}m
            ${b.item_url ? `<a class="row-link" href="${App.esc(b.item_url)}" target="_blank" title="open the assignment">↗</a>` : ''}
          </div>
          <span class="b-x" data-del="${b.id}">✕</span>
          <div class="b-resize" data-resize="${b.id}"></div>
        </div>`;
      }).join('')}
      ${ghosts.map((g, gi) => `
        <div class="pg-block ghost" data-ghost="${gi}" title="proposed — click to accept"
          style="top:${pos(Math.max(v.START_MIN, g.start_min))}px;height:${Math.max(20, g.duration_min * v.PX_PER_MIN)}px">
          <div class="b-title">${App.esc(g._title || 'block')}</div>
          <div class="b-meta">${g.duration_min}m · proposed</div>
        </div>`).join('')}
    </div>`;
  },

  trayBlockHtml(b) {
    const title = b.item_title || b.title || '(removed task)';
    return `<span class="tray-block" draggable="true" data-drag='${App.esc(JSON.stringify({ type: 'block', id: b.id }))}'>${App.esc(title)} <span data-del="${b.id}" style="cursor:pointer;color:#5c6674">✕</span></span>`;
  },

  wire(root) {
    const v = App.views.planner;

    App.$('#pl-prev', root).addEventListener('click', () => { v.offset--; v.proposals = []; v.render(); });
    App.$('#pl-next', root).addEventListener('click', () => { v.offset++; v.proposals = []; v.render(); });
    const back = App.$('#pl-today', root);
    if (back) back.addEventListener('click', () => { v.offset = 0; v.render(); });

    const planBtn = App.$('#pl-plan', root);
    if (planBtn) planBtn.addEventListener('click', async () => {
      planBtn.disabled = true;
      planBtn.textContent = '✦ Thinking…';
      try {
        const res = await App.api('/api/planner/suggest', { method: 'POST', body: {} });
        v.proposalDate = res.date;
        v.proposals = res.proposals.map((p) => ({
          ...p,
          _title: p.item_id
            ? (App.items.find((i) => i.id === p.item_id) || {}).title || 'task'
            : p.title || 'block',
        }));
        v.offset = 0;
        v.draw();
        if (!v.proposals.length) alert('The planner came back empty — everything may already fit.');
      } catch (err) {
        alert(err.message);
        v.draw();
      }
    });

    const acceptBtn = App.$('#pl-accept', root);
    if (acceptBtn) acceptBtn.addEventListener('click', async () => {
      for (const g of v.proposals) await v.acceptGhost(g, false);
      v.proposals = [];
      v.load();
    });
    const dismissBtn = App.$('#pl-dismiss', root);
    if (dismissBtn) dismissBtn.addEventListener('click', () => { v.proposals = []; v.draw(); });

    // Drag sources.
    root.addEventListener('dragstart', (e) => {
      const el = e.target.closest('[data-drag]');
      if (!el) return;
      e.dataTransfer.setData('text/plain', el.dataset.drag);
      e.dataTransfer.effectAllowed = 'move';
    });

    // Drop targets: day columns + tray strips.
    for (const col of App.$$('.pg-col, .pg-daystrip', root)) {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        let data;
        try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
        const date = col.dataset.date;
        const startMin = col.dataset.tray ? null : v.yToMin(e, col);
        try {
          if (data.type === 'item') {
            const item = App.items.find((i) => i.id === data.id);
            await App.api('/api/blocks', { method: 'POST', body: {
              item_id: data.id, date, start_min: startMin,
              duration_min: (item && item.estimate_min) || 60,
            } });
          } else if (data.type === 'block') {
            await App.api(`/api/blocks/${data.id}`, { method: 'PATCH', body: { date, start_min: startMin } });
          }
          v.load();
        } catch (err) { alert(err.message); }
      });
    }

    // Block actions: check, delete, resize, accept ghost. Custom block create.
    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        await App.api(`/api/blocks/${del.dataset.del}`, { method: 'DELETE' }).catch((err) => alert(err.message));
        v.load();
        return;
      }
      const ghost = e.target.closest('[data-ghost]');
      if (ghost) {
        const g = v.proposals[Number(ghost.dataset.ghost)];
        v.proposals = v.proposals.filter((x) => x !== g);
        await v.acceptGhost(g, true);
        return;
      }
    });

    root.addEventListener('change', async (e) => {
      const check = e.target.closest('[data-check]');
      if (!check) return;
      const block = v.blocks.find((b) => b.id === Number(check.dataset.check));
      if (!block) return;
      try {
        if (block.item_id) {
          await App.api(`/api/items/${block.item_id}`, { method: 'PATCH', body: { status: check.checked ? 'done' : 'not_started' } });
          await App.refresh();
        } else {
          await App.api(`/api/blocks/${block.id}`, { method: 'PATCH', body: { done: check.checked } });
        }
        v.load();
      } catch (err) { alert(err.message); }
    });

    root.addEventListener('dblclick', (e) => {
      const col = e.target.closest('.pg-col');
      if (!col || e.target.closest('.pg-block')) return;
      const title = prompt('Block title (e.g. "gym", "review 2550 notes"):');
      if (!title || !title.trim()) return;
      const startMin = v.yToMin(e, col);
      App.api('/api/blocks', { method: 'POST', body: { title: title.trim(), date: col.dataset.date, start_min: startMin, duration_min: 60 } })
        .then(() => v.load())
        .catch((err) => alert(err.message));
    });

    // Resize with plain mouse events — HTML5 DnD can't do it.
    root.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('[data-resize]');
      if (!handle) return;
      e.preventDefault();
      const blockEl = handle.closest('.pg-block');
      const id = Number(handle.dataset.resize);
      const block = v.blocks.find((b) => b.id === id);
      if (!block) return;
      const startY = e.clientY;
      const startDur = block.duration_min;

      const move = (ev) => {
        const dur = Math.max(15, Math.round((startDur + (ev.clientY - startY) / v.PX_PER_MIN) / 15) * 15);
        blockEl.style.height = `${Math.max(20, dur * v.PX_PER_MIN)}px`;
        blockEl.dataset.newDur = dur;
      };
      const up = async () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        const dur = Number(blockEl.dataset.newDur || startDur);
        if (dur !== startDur) {
          await App.api(`/api/blocks/${id}`, { method: 'PATCH', body: { duration_min: dur } }).catch((err) => alert(err.message));
        }
        v.load();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  },

  async acceptGhost(g, redraw) {
    const v = App.views.planner;
    try {
      await App.api('/api/blocks', { method: 'POST', body: {
        item_id: g.item_id, title: g.item_id ? null : (g._title || 'block'),
        date: v.proposalDate, start_min: g.start_min, duration_min: g.duration_min,
      } });
      if (redraw) v.load();
    } catch (err) { alert(err.message); }
  },
};

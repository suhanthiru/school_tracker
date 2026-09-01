'use strict';

// Week grid: Mon–Sun columns with everything landing on its due date —
// deadlines and calendar events together, so crunch days are visible.

App.views.week = {
  offset: 0, // weeks from the current one

  weekStart(offset = 0) {
    const now = new Date();
    const day = (now.getDay() + 6) % 7; // Monday = 0
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + offset * 7).getTime();
  },

  render() {
    const root = App.$('#view-week');
    const v = App.views.week;
    const start = v.weekStart(v.offset);
    const end = start + 7 * App.DAY;
    const todayISO = App.localISO(Date.now());

    const inWeek = App.items.filter((i) => i.due_at && i.due_at >= start && i.due_at < end);

    const sourceDot = { canvas: '#d47c6a', gradescope: '#6ab7d4', ed: '#8a93e8', gcal: '#8fc98f', manual: '#8a95a5' };

    const startD = new Date(start);
    const endD = new Date(end - App.DAY);
    const title = `${startD.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${endD.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

    let html = `
      <div class="cal-nav">
        <button class="btn" id="wk-prev">◀</button>
        <span class="cal-title">${title}${v.offset === 0 ? '' : v.offset > 0 ? ` (+${v.offset}w)` : ` (${v.offset}w)`}</span>
        <button class="btn" id="wk-next">▶</button>
        ${v.offset !== 0 ? '<button class="btn ghost" id="wk-today">back to this week</button>' : ''}
      </div>
      <div id="week-grid">`;

    for (let d = 0; d < 7; d++) {
      const dayStart = start + d * App.DAY;
      const date = new Date(dayStart);
      const iso = App.localISO(dayStart);
      const dayItems = inWeek
        .filter((i) => App.localISO(i.due_at) === iso)
        .sort((a, b) => (a.all_day ? -1 : b.all_day ? 1 : a.due_at - b.due_at));

      html += `
        <div class="day-col ${iso === todayISO ? 'today' : ''}">
          <div class="day-head">
            <span>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]}</span>
            <span class="d-num">${date.getDate()}</span>
          </div>
          ${dayItems.map((i) => {
            const t = i.all_day ? '' : new Date(i.due_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: i.due_at % 3600000 ? '2-digit' : undefined }).toLowerCase().replace(' ', '');
            const done = i.status === 'done' || i.submitted_any;
            return `<div class="wk-item ${done ? 'done-row' : ''}" title="${App.esc(i.title)}${i.course_code ? ' — ' + App.esc(i.course_code) : ''}">
              <span class="dot" style="background:${sourceDot[i.source] || '#666'}"></span>
              ${t ? `<span class="wk-time">${t}</span>` : ''}
              <span class="wk-title">${i.url ? `<a href="${App.esc(i.url)}" target="_blank">${App.esc(i.title)}</a>` : App.esc(i.title)}</span>
            </div>`;
          }).join('') || '<div class="faint" style="font-size:11px;padding:4px">—</div>'}
        </div>`;
    }
    html += '</div>';

    root.innerHTML = html;
    App.$('#wk-prev', root).addEventListener('click', () => { v.offset--; v.render(); });
    App.$('#wk-next', root).addEventListener('click', () => { v.offset++; v.render(); });
    const back = App.$('#wk-today', root);
    if (back) back.addEventListener('click', () => { v.offset = 0; v.render(); });
  },
};

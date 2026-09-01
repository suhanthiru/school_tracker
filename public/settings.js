'use strict';

// Settings modal + first-run onboarding. Test buttons save first, then make
// one live read-only call so a bad token is caught at paste time.

const Syllabus = {
  wired: false,

  open() {
    const sel = App.$('#syl-course');
    sel.innerHTML = '<option value="">(no course)</option>' + App.courses
      .map((c) => `<option value="${c.id}">${App.esc(c.code || c.name)}</option>`).join('');
    App.$('#syl-result').textContent = '';
    App.$('#syl-file').classList.toggle('hidden', !(App.meta && App.meta.claude));
    App.$('#syllabus-modal').classList.remove('hidden');
    Syllabus.wire();
  },

  wire() {
    if (Syllabus.wired) return;
    Syllabus.wired = true;

    App.$('#close-syllabus').addEventListener('click', () =>
      App.$('#syllabus-modal').classList.add('hidden'));

    App.$('#syl-import').addEventListener('click', async () => {
      const out = App.$('#syl-result');
      const text = App.$('#syl-text').value;
      if (!text.trim()) { out.textContent = 'paste the syllabus text first'; out.className = 'test-result err'; return; }
      out.textContent = App.meta && App.meta.claude ? 'reading with AI…' : 'scanning for dates…';
      out.className = 'test-result';
      try {
        const r = await App.api('/api/syllabus/import', { method: 'POST', body: {
          text, course_id: App.$('#syl-course').value || null,
        } });
        out.textContent = `${r.total} items (${r.added} new, ${r.updated} updated)`;
        out.className = 'test-result ok';
        App.$('#syl-text').value = '';
        App.refresh().catch(() => {});
      } catch (err) {
        out.textContent = err.message;
        out.className = 'test-result err';
      }
    });

    App.$('#syl-file').addEventListener('click', async () => {
      await App.api('/api/syllabus/pick', { method: 'POST', body: { course_id: App.$('#syl-course').value || null } });
      App.$('#syl-result').textContent = 'choose the file in the dialog — result arrives as a toast';
      App.$('#syl-result').className = 'test-result';
    });
  },
};

const Settings = {
  data: null,

  async open() {
    Settings.data = await App.api('/api/settings');
    App.$('#settings-body').innerHTML = Settings.formHtml();
    Settings.wire(App.$('#settings-body'));
    App.$('#settings-modal').classList.remove('hidden');
  },

  close() {
    App.$('#settings-modal').classList.add('hidden');
    if (location.hash === '#settings') location.hash = App.tab;
    App.refresh().catch(() => {});
  },

  secretField(key, placeholder) {
    const has = Settings.data[`has_${key}`];
    return `<input type="password" data-secret="${key}" placeholder="${has ? '••••••••  (saved — paste to replace)' : placeholder}" autocomplete="off">`;
  },

  formHtml() {
    const d = Settings.data;
    const gsState = d.gradescope_state;
    return `
    <div class="set-section">
      <h3>Canvas</h3>
      <div class="set-hint">Covers assignments, quizzes, due dates, and submission status — Perusall items come through here too. <b>Georgia Tech blocks student access tokens</b>, so sign in with your school login instead; the token field is for schools that allow tokens.</div>
      <div class="set-row"><input type="text" data-plain="canvas_base_url" value="${App.esc(d.canvas_base_url)}" style="width:280px" title="Canvas base URL"></div>
      <div class="set-row">
        <span class="${d.canvas_state === 'ok' ? 'test-result ok' : 'dim'}" style="font-size:12.5px">
          ${d.canvas_state === 'ok' ? 'Signed in ✓' : d.canvas_state === 'expired' ? 'Session expired' : 'Not signed in'}
        </span>
        <button class="btn" data-sso="canvas" data-sso-act="connect">${d.canvas_state === 'ok' ? 'Reconnect' : 'Connect with school login'}</button>
        ${d.canvas_state !== 'never' ? '<button class="btn ghost" data-sso="canvas" data-sso-act="disconnect">Disconnect</button>' : ''}
      </div>
      <div class="set-row">${Settings.secretField('canvas_token', 'or paste an access token (if your school allows them)')}
        <button class="btn" data-test="canvas">Test</button><span class="test-result" id="test-canvas"></span></div>
    </div>

    <div class="set-section">
      <h3>Google Calendar</h3>
      <div class="set-hint">Google Calendar → Settings → your calendar → <b>Integrate calendar</b> → "Secret address in iCal format". Google refreshes this feed lazily (up to a few hours behind).</div>
      <div class="set-row">${Settings.secretField('gcal_ics_url', 'paste the secret .ics address')}
        <button class="btn" data-test="gcal">Test</button><span class="test-result" id="test-gcal"></span></div>
    </div>

    <div class="set-section">
      <h3>Ed Discussions</h3>
      <div class="set-hint">edstem.org → Settings → <b>API Tokens</b> → New token. Pulls announcements; deadlines mentioned in them are extracted onto the radar.</div>
      <div class="set-row"><input type="text" data-plain="ed_base_url" value="${App.esc(d.ed_base_url)}" style="width:280px" title="Ed API base URL"></div>
      <div class="set-row">${Settings.secretField('ed_token', 'paste Ed API token')}
        <button class="btn" data-test="ed">Test</button><span class="test-result" id="test-ed"></span></div>
    </div>

    <div class="set-section">
      <h3>Gradescope</h3>
      <div class="set-hint">No API exists, so the app signs in as you once (GT SSO + Duo in a popup window) and keeps the session. When Gradescope expires it, you'll get a toast to reconnect.</div>
      <div class="set-row">
        <span class="${gsState === 'ok' ? 'test-result ok' : 'dim'}" style="font-size:12.5px">
          ${gsState === 'ok' ? 'Connected ✓' : gsState === 'expired' ? 'Session expired' : 'Not connected'}
        </span>
        <button class="btn" data-sso="gradescope" data-sso-act="connect">${gsState === 'ok' ? 'Reconnect' : 'Connect Gradescope'}</button>
        ${gsState !== 'never' ? '<button class="btn ghost" data-sso="gradescope" data-sso-act="disconnect">Disconnect</button>' : ''}
        <button class="btn" data-test="gradescope">Test</button><span class="test-result" id="test-gradescope"></span>
      </div>
    </div>

    <div class="set-section">
      <h3>Morning digest</h3>
      <div class="set-hint">Emails your day to you (works on your phone). Needs a Gmail <b>app password</b>: myaccount.google.com → Security → 2-Step Verification → App passwords.</div>
      <div class="set-row">
        <label class="check"><input type="checkbox" data-plain-check="digest_enabled" ${d.digest_enabled === '1' ? 'checked' : ''}> enabled</label>
        at <input type="text" data-plain="digest_time" value="${App.esc(d.digest_time)}" style="width:64px" placeholder="07:30">
      </div>
      <div class="set-row"><input type="text" data-plain="gmail_address" value="${App.esc(d.gmail_address)}" placeholder="you@gmail.com" style="width:240px"></div>
      <div class="set-row">${Settings.secretField('gmail_app_password', 'paste 16-character app password')}
        <button class="btn" data-digest-test>Send test digest</button><span class="test-result" id="test-digest"></span></div>
    </div>

    <div class="set-section">
      <h3>General</h3>
      <div class="set-row">Sync every <input type="text" data-plain="sync_interval_min" value="${App.esc(d.sync_interval_min)}" style="width:46px"> min</div>
      <div class="set-row">Quick-capture hotkey <input type="text" data-plain="capture_hotkey" value="${App.esc(d.capture_hotkey)}" style="width:190px" placeholder="Control+Shift+Space"></div>
      <div class="set-row"><label class="check"><input type="checkbox" data-plain-check="treat_submitted_as_done" ${d.treat_submitted_as_done === '1' ? 'checked' : ''}> group submitted items with done</label></div>
      ${Settings.coursesHtml()}
    </div>

    <div class="set-row" style="margin-top:12px; justify-content:flex-end">
      <span class="test-result" id="save-result"></span>
      <button class="btn primary" id="save-settings">Save</button>
    </div>`;
  },

  coursesHtml() {
    if (!App.courses) return '';
    const all = App.courses;
    if (!all.length) return '';
    return `<details style="margin-top:6px"><summary class="dim" style="cursor:pointer;font-size:12.5px">Courses (hide old ones)</summary>
      ${all.map((c) => `<div class="set-row" style="margin:4px 0 0 12px">
        <label class="check"><input type="checkbox" data-course="${c.id}" ${c.hidden ? '' : 'checked'}>
        ${App.esc(c.code || c.name)} <span class="faint">(${App.sourceName(c.source)})</span></label>
      </div>`).join('')}
    </details>`;
  },

  collect(root) {
    const body = {};
    for (const el of App.$$('[data-plain]', root)) body[el.dataset.plain] = el.value.trim();
    for (const el of App.$$('[data-plain-check]', root)) body[el.dataset.plainCheck] = el.checked ? '1' : '0';
    for (const el of App.$$('[data-secret]', root)) {
      if (el.value.trim()) body[el.dataset.secret] = el.value.trim();
    }
    return body;
  },

  async save(root) {
    await App.api('/api/settings', { method: 'PUT', body: Settings.collect(root) });
    Settings.data = await App.api('/api/settings');
  },

  wire(root) {
    App.$('#save-settings', root).addEventListener('click', async () => {
      const out = App.$('#save-result', root);
      try {
        await Settings.save(root);
        out.textContent = 'saved';
        out.className = 'test-result ok';
        setTimeout(() => { out.textContent = ''; }, 2500);
      } catch (err) {
        out.textContent = err.message;
        out.className = 'test-result err';
      }
    });

    for (const btn of App.$$('[data-test]', root)) {
      btn.addEventListener('click', async () => {
        const source = btn.dataset.test;
        const out = App.$(`#test-${source}`, root);
        out.textContent = 'testing…';
        out.className = 'test-result';
        try {
          await Settings.save(root);
          const res = await App.api(`/api/settings/test/${source}`, { method: 'POST' });
          out.textContent = res.detail;
          out.className = `test-result ${res.ok ? 'ok' : 'err'}`;
        } catch (err) {
          out.textContent = err.message;
          out.className = 'test-result err';
        }
      });
    }

    for (const btn of App.$$('[data-sso]', root)) {
      btn.addEventListener('click', async () => {
        const service = btn.dataset.sso;
        if (btn.dataset.ssoAct === 'connect') {
          await App.api(`/api/sso/${service}/connect`, { method: 'POST' });
        } else {
          await App.api(`/api/sso/${service}/disconnect`, { method: 'POST' });
          Settings.open();
        }
      });
    }

    const digestTest = App.$('[data-digest-test]', root);
    if (digestTest) digestTest.addEventListener('click', async () => {
      const out = App.$('#test-digest', root);
      out.textContent = 'building + sending…';
      out.className = 'test-result';
      try {
        await Settings.save(root);
        const res = await App.api('/api/digest/send', { method: 'POST' });
        out.textContent = `sent: "${res.subject}"`;
        out.className = 'test-result ok';
      } catch (err) {
        out.textContent = err.message;
        out.className = 'test-result err';
      }
    });

    for (const check of App.$$('[data-course]', root)) {
      check.addEventListener('change', () => {
        App.api(`/api/courses/${check.dataset.course}`, { method: 'PATCH', body: { hidden: !check.checked } })
          .catch((err) => alert(err.message));
      });
    }
  },

  // ---------- onboarding ----------

  async openOnboarding() {
    Settings.data = await App.api('/api/settings');
    const body = App.$('#onboarding-body');
    body.innerHTML = `
      <div class="modal-title" style="margin-bottom:4px">Let's wire everything up</div>
      <div class="set-hint" style="margin-bottom:14px">Each source takes about a minute. Skip anything — you can add it later in Settings. Canvas alone already covers most of your workload.</div>
      ${Settings.formHtml()}
      <div class="set-row" style="justify-content:flex-end;margin-top:8px">
        <button class="btn" id="ob-skip">Skip for now</button>
        <button class="btn primary" id="ob-finish">Finish & first sync</button>
      </div>`;
    Settings.wire(body);
    App.$('#save-settings', body).classList.add('hidden');

    const done = async () => {
      try { await Settings.save(body); } catch { /* partial is fine */ }
      await App.api('/api/settings', { method: 'PUT', body: { onboarded: '1' } });
      App.$('#onboarding').classList.add('hidden');
      App.api('/api/sync', { method: 'POST' }).then(() => App.refresh()).catch(() => {});
      App.refresh().catch(() => {});
    };
    App.$('#ob-skip', body).addEventListener('click', done);
    App.$('#ob-finish', body).addEventListener('click', done);

    App.$('#onboarding').classList.remove('hidden');
  },
};

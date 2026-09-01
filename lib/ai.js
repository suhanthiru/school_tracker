'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MAX_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 90 * 1000;

// ---------- locating the claude CLI ----------

let claudeBin = null;

function resolveClaude() {
  if (claudeBin) return claudeBin;

  // Escape hatch for a non-standard install location.
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) {
    claudeBin = process.env.CLAUDE_BIN;
    return claudeBin;
  }

  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { claudeBin = c; return claudeBin; }
  }

  // Fall back to PATH lookup.
  const which = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(which, ['claude'], { encoding: 'utf8' });
  if (found.status === 0) {
    const first = String(found.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) { claudeBin = first; return claudeBin; }
  }
  return null;
}

const claudeAvailable = () => !!resolveClaude();

/** Turn the CLI's raw failure text into something actionable in the UI. */
function friendlyError(message) {
  const text = String(message || '').trim();
  if (/oauth|authenticate|not logged in|login/i.test(text)) {
    return 'Claude login expired. Open a terminal, run "claude", and sign in — then try again.';
  }
  if (/rate limit|usage limit|quota/i.test(text)) {
    return 'Claude usage limit reached. Try again once your limit resets.';
  }
  return text || 'The claude CLI failed without a message.';
}

/**
 * Run the claude CLI headlessly with the prompt on stdin and resolve with its
 * stdout (or the JSON result field when json: true).
 */
function runClaude(prompt, { tools = [], timeout = DEFAULT_TIMEOUT_MS, json = true } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveClaude();
    if (!bin) {
      reject(new Error('The claude CLI was not found. Install it and make sure it is on your PATH.'));
      return;
    }

    const args = ['-p', '--permission-mode', 'dontAsk'];
    if (json) args.push('--output-format', 'json');
    if (tools.length) args.push('--allowedTools', ...tools);

    // Node on Windows refuses to spawn .cmd/.bat directly (it throws EINVAL),
    // and an npm-global claude install is exactly that — so route batch
    // wrappers through a shell, quoting the path in case it contains spaces.
    const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const child = spawn(isBatch ? `"${bin}"` : bin, args, {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      shell: isBatch,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // The CLI reports real failures (expired login, rate limits) in its JSON
      // result while still exiting non-zero, so parse stdout before trusting
      // the exit code.
      let parsed = null;
      if (json && stdout.trim()) {
        try { parsed = JSON.parse(stdout); } catch { /* not JSON after all */ }
      }

      if (parsed && parsed.is_error) {
        reject(new Error(friendlyError(parsed.result || 'claude reported an error')));
        return;
      }
      if (code !== 0) {
        reject(new Error(friendlyError(
          (parsed && parsed.result) || stderr.trim() || `claude exited with code ${code}`
        )));
        return;
      }
      if (!json) { resolve(stdout); return; }
      if (parsed) { resolve(String(parsed.result ?? '')); return; }
      resolve(stdout); // Unexpected output shape: hand back the raw text.
    });

    child.stdin.end(prompt);
  });
}

// ---------- a small queue, so a burst of syncs cannot fork 20 processes ----------

const queue = [];
let running = 0;

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}

function drain() {
  while (running < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    running++;
    fn().then(resolve, reject).finally(() => { running--; drain(); });
  }
}

const queueDepth = () => running + queue.length;

/** Replies arrive wrapped in fences and chatter however firmly the prompt
 *  forbids it — dig the first JSON object/array out of the text. */
function extractJson(text) {
  const s = String(text || '');
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in reply');
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (!depth) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON in reply');
}

// ---------- task-specific calls ----------

const fmtLocal = (epoch) => {
  const d = new Date(epoch);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Pull the one deadline an announcement names. Resolves to epoch ms or null.
 */
function extractDueDate({ title, text, courseCode, now = Date.now() }) {
  const prompt = `Today is ${fmtLocal(now)}. A course announcement from ${courseCode || 'a class'} follows.
If it announces, moves, or restates exactly ONE deadline/exam/quiz date, return that date.
If it names no deadline, or several, return null.

Return ONLY JSON, nothing else: {"due": "YYYY-MM-DDTHH:mm"} or {"due": null}
Use 23:59 when no time is given.

TITLE: ${title}
BODY:
${String(text || '').slice(0, 4000)}`;

  return enqueue(() => runClaude(prompt, { timeout: 60 * 1000 })).then((reply) => {
    const parsed = extractJson(reply);
    if (!parsed || !parsed.due) return null;
    const m = String(parsed.due).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  });
}

/**
 * 3–4 sentence morning brief for the digest. Resolves to plain text.
 */
function morningBrief(summary) {
  const prompt = `You are the opening paragraph of a college student's morning assignment digest.
Below is today's workload data. Write 3-4 plain sentences: what kind of day it is,
what matters most (weigh due-times and point values), and one concrete suggestion
for what to start with. No greetings, no markdown, no bullet points, no emoji.

${String(summary).slice(0, 6000)}`;

  return enqueue(() => runClaude(prompt, { timeout: 90 * 1000 })).then((r) => String(r).trim());
}

/**
 * Propose time blocks for today. Resolves to [{item_id?, title?, start_min, duration_min}].
 */
function planDay(payload) {
  const prompt = `Today is ${fmtLocal(payload.now)}. Plan a student's work day.

TASKS (JSON): ${JSON.stringify(payload.tasks)}
BUSY (classes/meetings, cannot move, JSON): ${JSON.stringify(payload.busy)}
ALREADY PLANNED (JSON): ${JSON.stringify(payload.planned)}

Rules:
- This is TODAY's study plan, not a semester plan. Deadline order: overdue first,
  then due today, then due tomorrow. Include something further out only if the
  near-term work leaves clear free time.
- Schedule between ${payload.dayStartMin} and 1380 minutes-from-midnight, never overlapping BUSY or ALREADY PLANNED ranges, never in the past (now is minute ${payload.nowMin}).
- Use each task's estimate_min when present; otherwise estimate a sensible duration from its kind and points (a problem set is hours, a reading quiz is not).
- Prefer FEW long focus blocks over many slivers; leave 10-15 min gaps between blocks. It is fine to schedule only 2-4 blocks and leave the rest of the day alone.

Return ONLY a JSON array, nothing else:
[{"item_id": <id>, "start_min": <int>, "duration_min": <int>}, ...]`;

  return enqueue(() => runClaude(prompt, { timeout: 90 * 1000 })).then((reply) => {
    const arr = extractJson(reply);
    if (!Array.isArray(arr)) throw new Error('planner reply was not a list');
    return arr
      .filter((b) => b && Number.isFinite(Number(b.start_min)) && Number.isFinite(Number(b.duration_min)))
      .map((b) => ({
        item_id: b.item_id != null ? Number(b.item_id) : null,
        title: b.title ? String(b.title) : null,
        start_min: Math.max(0, Math.min(23 * 60 + 45, Math.round(Number(b.start_min) / 15) * 15)),
        duration_min: Math.max(15, Math.min(8 * 60, Math.round(Number(b.duration_min) / 15) * 15)),
      }));
  });
}

/**
 * Pull every dated deliverable out of a syllabus. Pass `text` (pasted) or
 * `filePath` (the CLI reads the PDF/document itself via its Read tool).
 * Resolves to [{title, kind, due: epoch|null, points|null}].
 */
function extractSyllabus({ text = null, filePath = null, courseCode = '', now = Date.now() }) {
  const source = filePath
    ? `First use the Read tool to read the syllabus file at: ${filePath}`
    : `The syllabus text follows after the rules.`;

  const prompt = `Today is ${fmtLocal(now)}. ${source}
Extract every graded deliverable and exam a student must track from this ${courseCode || ''} syllabus:
homework/psets, projects, essays, quizzes, midterms, finals, presentations — anything with a date.
Skip lecture topics, readings without deliverables, office hours, and policies.

Rules:
- kind is one of: assignment, quiz (use quiz for exams/midterms/finals too), task
- due is "YYYY-MM-DDTHH:mm" when the syllabus gives a date (23:59 when no time given;
  infer the year from today's date and the term), null when it truly has none
- points is the point/percentage weight as a number when stated, else null
- at most 60 entries

Return ONLY a JSON array, nothing else:
[{"title": "...", "kind": "assignment", "due": "YYYY-MM-DDTHH:mm" | null, "points": 10 | null}, ...]
${text ? `\nSYLLABUS:\n${String(text).slice(0, 24000)}` : ''}`;

  return enqueue(() => runClaude(prompt, {
    timeout: 4 * 60 * 1000,
    tools: filePath ? ['Read'] : [],
  })).then((reply) => {
    const arr = extractJson(reply);
    if (!Array.isArray(arr)) throw new Error('syllabus reply was not a list');
    return arr.slice(0, 60)
      .filter((e) => e && String(e.title || '').trim())
      .map((e) => {
        let due = null;
        const m = e.due && String(e.due).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
        if (m) due = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
        return {
          title: String(e.title).trim().slice(0, 300),
          kind: ['assignment', 'quiz', 'task'].includes(e.kind) ? e.kind : 'assignment',
          due,
          points: Number.isFinite(Number(e.points)) ? Number(e.points) : null,
        };
      });
  });
}

module.exports = {
  claudeAvailable, runClaude, enqueue, queueDepth, friendlyError, extractJson,
  extractDueDate, morningBrief, planDay, extractSyllabus,
};

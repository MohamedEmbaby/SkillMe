#!/usr/bin/env node
'use strict';
/**
 * SkillMe MCP server (stdio, zero dependencies) + the Arena web UI (http://127.0.0.1:4747).
 *
 * Works with any MCP client: Claude Code, Claude Desktop, Cursor, Windsurf, VS Code Copilot,
 * Codex CLI, Gemini CLI... The AI pushes short quizzes about the code it writes; the user answers them
 * ONLY in the Arena, never in the coding session. A separate tutor AI (via OpenRouter) answers questions and judges challenges.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core');
const tutor = require('./tutor');
const desktop = require('./app');

const log = (...a) => process.stderr.write('[skillme] ' + a.join(' ') + '\n');

// ============================================================== Arena HTTP server
let arenaUrl = null;
let arenaServer = null;
let arenaStarting = null;
let openedOnce = false;
const viewerTouched = {};

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 600 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'skillme'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function listen(port) {
  return new Promise((resolve) => {
    const srv = http.createServer(handleHttp);
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => { srv.unref(); resolve(srv); });
  });
}

/** Make sure some SkillMe arena is reachable; host it here if nobody else does. */
async function ensureArena() {
  if (arenaServer) return arenaUrl;
  if (arenaStarting) return arenaStarting;
  arenaStarting = (async () => {
    const base = Number(process.env.SKILLME_PORT) || core.getConfig().port || 4747;
    const host = process.env.SKILLME_NO_HOST !== '1'; // short-lived CLI calls only look for a running arena
    for (let port = base; port < base + 6; port++) {
      const srv = host ? await listen(port) : null;
      if (srv) {
        arenaServer = srv; arenaUrl = `http://127.0.0.1:${port}`; log('arena hosted at', arenaUrl);
        tutor.status(); // starts the (free) key check early so the Arena shows the real tutor state
        return arenaUrl;
      }
      if (await ping(port)) { arenaUrl = `http://127.0.0.1:${port}`; return arenaUrl; }
    }
    arenaUrl = null;
    return null;
  })();
  try { return await arenaStarting; } finally { arenaStarting = null; }
}

/** Open the Arena on a project: in its own window when the app runtime is installed, else in the browser. */
function openArena(url, slug) {
  if (core.getConfig().openIn !== 'browser' && desktop.launch(slug)) return true;
  return openBrowser(slug ? `${url}/?p=${encodeURIComponent(slug)}` : url);
}

function openBrowser(url) {
  try {
    const opts = { detached: true, stdio: 'ignore', windowsHide: true };
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], opts).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).unref();
    return true;
  } catch { return false; }
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

function rootForSlug(slug) {
  const s = slug && core.loadStateBySlug(slug);
  return s ? s.project.root : null;
}

// ---------------------------------------------------------------- the window app, from the Arena menu
// Anyone can install it from the Arena (menu -> Window) without knowing where the plugin lives.
const appJob = { installing: false, error: null };
const STATUSLINE_CMD = `node "${path.join(__dirname, '..', 'scripts', 'statusline.js').split(path.sep).join('/')}"`;
function appInfo() {
  return { installed: desktop.installed(), installing: appJob.installing, error: appJob.error, version: desktop.ELECTRON_VERSION, statusline: STATUSLINE_CMD };
}
function installApp() {
  if (appJob.installing || desktop.installed()) return;
  appJob.installing = true; appJob.error = null;
  desktop.install({ quiet: true })
    .then((ok) => { appJob.error = ok ? null : 'The download did not finish. Check your connection and try again.'; })
    .catch(() => { appJob.error = 'The download did not finish. Check your connection and try again.'; })
    .finally(() => { appJob.installing = false; });
}

async function handleHttp(req, res) {
  try {
    // Local-only hygiene: refuse foreign Host headers (DNS rebinding) and non-JSON POSTs (CSRF).
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return sendJson(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'arena.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/sprites/')) {
      // The Arena's art (built from the generated sheets by scripts/build-atlas.js). Plain names only: no paths.
      const name = url.pathname.slice('/assets/sprites/'.length);
      if (!/^[a-z0-9_-]+\.(png|json)$/i.test(name)) return sendJson(res, 404, { error: 'not found' });
      return fs.readFile(path.join(__dirname, '..', 'assets', 'sprites', name), (err, buf) => {
        if (err) return sendJson(res, 404, { error: 'not found' });
        // The manifest says which sprites exist (new sheets add some), so it is never cached; images briefly.
        res.writeHead(200, { 'Content-Type': name.endsWith('.png') ? 'image/png' : 'application/json', 'Cache-Control': name.endsWith('.json') ? 'no-cache' : 'max-age=300' });
        res.end(buf);
      });
    }
    if (url.pathname === '/api/ping') return sendJson(res, 200, { app: 'skillme', version: core.VERSION });
    if (url.pathname === '/api/projects') return sendJson(res, 200, { projects: core.listProjects() });

    if (req.method === 'GET' && url.pathname === '/api/state') {
      let slug = url.searchParams.get('p');
      let s = slug && core.loadStateBySlug(slug);
      if (!s) { // unknown or deleted project (e.g. a stale link): fall back to the most recent one
        slug = (core.listProjects()[0] || {}).slug;
        s = slug && core.loadStateBySlug(slug);
      }
      if (!s) return sendJson(res, 200, { empty: true, projects: core.listProjects() });
      if (!viewerTouched[slug] || Date.now() - viewerTouched[slug] > 4000) {
        viewerTouched[slug] = Date.now();
        core.touchViewer(slug);
      }
      const tutorStatus = tutor.status();
      if (s.quizzes.some((q) => q.tutorBusy && (q.tutorWaiting ? tutorStatus.available : Date.now() - (q.tutorBusyAt || 0) > core.TUTOR_STALE_MS))) {
        s = pumpTutorJobs(s.project.root, tutorStatus.available);
      }
      return sendJson(res, 200, { ...core.publicState(s, true, tutorStatus), app: appInfo() });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (!String(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { error: 'json only' });
      const body = await readBody(req);
      if (url.pathname === '/api/tutor') {
        // The key goes from the user's own Arena page to ~/.skillme/secrets.json; it is never sent back.
        if (typeof body.openrouterKey === 'string') {
          const r = tutor.saveKey(body.openrouterKey);
          if (!r.ok) return sendJson(res, 200, r);
        }
        if (typeof body.model === 'string') {
          const r = tutor.setModel(body.model);
          if (!r.ok) return sendJson(res, 200, r);
        }
        return sendJson(res, 200, { ok: true, tutor: tutor.status() });
      }
      if (url.pathname === '/api/app') {
        // The window app: the user clicked Install (a ~110 MB download into ~/.skillme/app) or Open.
        if (body.action === 'install') { installApp(); return sendJson(res, 200, { ok: true, app: appInfo() }); }
        if (body.action === 'open') {
          const slug = typeof body.p === 'string' && /^[\w.-]{1,120}$/.test(body.p) ? body.p : null;
          return sendJson(res, 200, desktop.launch(slug) ? { ok: true, app: appInfo() } : { ok: false, error: 'The window app is not installed yet.', app: appInfo() });
        }
        return sendJson(res, 400, { ok: false, error: 'unknown action' });
      }
      const root = rootForSlug(body.p);
      if (!root) return sendJson(res, 404, { error: 'unknown project' });
      const action = url.pathname.slice(5);
      if (action === 'storage') {
        // The "save in project" toggle: moves the quiz data (outside updateState: it changes where state lives).
        return sendJson(res, 200, core.setSaveInProject(root, !!body.inProject));
      }
      const tutorOn = tutor.status().available;
      const result = core.updateState(root, (s) => {
        const q = core.findQuiz(s, body.quizId);
        // Tutor work never goes to the coding session: it runs now, or waits until the tutor is available.
        const queue = (kind, question) => {
          q.tutorBusy = kind; q.tutorBusyAt = Date.now(); q.tutorQuestion = question || ''; q.tutorTries = 0;
          q.tutorWaiting = !tutorOn;
          return tutorOn ? { job: kind, question } : { waiting: true };
        };
        switch (action) {
          case 'restart': return core.restartQuizzes(s);
          case 'battle': return core.newBattle(s); // 'Fight again' after a knockout
          case 'seen': return { ok: core.markShown(s, body.quizId) };
          case 'answer': return core.answerQuiz(s, body.quizId, body.choice, 'arena');
          case 'skip': return { ok: core.skipQuiz(s, body.quizId) };
          case 'explain': {
            if (!q) return { ok: false, error: 'quiz not found' };
            core.requestExplain(s, q.id);
            // The quiz came with a pre-written deep dive: shown instantly, nobody has to work for it.
            if (q.deepDive) return { ok: true, routed: 'instant' };
            if (q.tutorBusy) return { ok: false, error: 'the tutor is already on it' };
            core.addThread(s, q.id, 'user', 'Explain this more deeply, please.');
            return { ok: true, routed: 'tutor', ...queue('ask', '') };
          }
          case 'ask': {
            const question = String(body.note || '').trim().slice(0, 600);
            if (!q || !question) return { ok: false, error: 'empty question' };
            if (q.tutorBusy) return { ok: false, error: 'the tutor is still answering your last question' };
            core.addThread(s, q.id, 'user', question);
            return { ok: true, routed: 'tutor', ...queue('ask', question) };
          }
          case 'challenge': {
            if (q && q.tutorBusy) return { ok: false, error: 'the tutor is busy with this quiz; try again in a moment' };
            const r = core.challengeQuiz(s, body.quizId, body.note, body.proposed);
            if (!r.ok) return r;
            return { ...r, routed: 'tutor', ...queue('judge', '') };
          }
          default: return { ok: false, error: 'unknown action' };
        }
      });
      if (result.job) startTutorJob(root, body.quizId, result.job, result.question);
      return sendJson(res, 200, result);
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    log('http error', e.stack || e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
}

// ============================================================== Tutor jobs (a separate AI, never the main session)
function tutorFailure(r) {
  if (r.ok) return 'its reply could not be read';
  if (r.reason === 'timeout') return 'it timed out';
  if (r.reason === 'network') return 'OpenRouter could not be reached';
  return String(r.detail || r.reason).slice(0, 120);
}

const MAX_TUTOR_TRIES = 3;

/** Clear a quiz's tutor job and tell the user it gave up. Nothing is ever handed to the coding session. */
function giveUp(s, quiz, kind, reason) {
  quiz.tutorBusy = null; quiz.tutorWaiting = false; quiz.tutorQuestion = '';
  if (kind === 'judge') core.cancelChallenge(s, quiz.id, reason);
  else core.addThread(s, quiz.id, 'system', `The tutor couldn't answer (${reason}). Ask again in a moment.`);
}

function startTutorJob(root, quizId, kind, question) {
  const q = core.findQuiz(core.loadState(root), quizId);
  if (!q) return;
  const prompt = kind === 'judge' ? tutor.judgePrompt(root, q) : tutor.askPrompt(root, q, question);
  tutor.run(prompt).then((r) => {
    core.updateState(root, (s) => {
      const quiz = core.findQuiz(s, quizId);
      if (!quiz || !quiz.tutorBusy) return;
      const json = r.ok ? tutor.extractJson(r.text) : null;
      const verdict = json && ['human_right', 'ai_right'].includes(json.verdict) ? json.verdict : null;
      const answered = kind === 'ask' ? r.ok : !!verdict;
      if (answered) {
        quiz.tutorBusy = null; quiz.tutorWaiting = false; quiz.tutorQuestion = '';
        if (kind === 'ask') core.addThread(s, quizId, 'tutor', (json && typeof json.answer === 'string' && json.answer) || r.text, { model: r.model });
        else core.resolveChallenge(s, quizId, verdict, String(json.explanation || ''), { by: 'tutor', fix: json.fix, model: r.model });
        return;
      }
      // No key, bad key, no credits, rate limit: keep waiting (it runs once that clears up). Other failures: retry, then give up.
      quiz.tutorTries = (quiz.tutorTries || 0) + (tutor.isBlocking(r.reason) ? 0 : 1);
      if (quiz.tutorTries >= MAX_TUTOR_TRIES) giveUp(s, quiz, kind, tutorFailure(r));
      else { quiz.tutorWaiting = true; quiz.tutorBusyAt = Date.now(); }
    });
  });
}

/**
 * Called from the Arena's polling: starts tutor jobs that were waiting (once the tutor is available)
 * and retries jobs lost with a crashed/closed process.
 */
function pumpTutorJobs(root, available) {
  const start = [];
  const s = core.updateState(root, (st) => {
    for (const q of st.quizzes) {
      if (!q.tutorBusy) continue;
      const stale = !q.tutorWaiting && Date.now() - (q.tutorBusyAt || 0) > core.TUTOR_STALE_MS;
      if (stale) {
        q.tutorTries = (q.tutorTries || 0) + 1;
        if (q.tutorTries >= MAX_TUTOR_TRIES) { giveUp(st, q, q.tutorBusy, 'it never replied'); continue; }
        q.tutorWaiting = true;
      }
      if (q.tutorWaiting && available) {
        q.tutorWaiting = false;
        q.tutorBusyAt = Date.now();
        start.push({ id: q.id, kind: q.tutorBusy, question: q.tutorQuestion || '' });
      }
    }
    return st;
  });
  for (const j of start) startTutorJob(root, j.id, j.kind, j.question);
  return s;
}

// ============================================================== MCP tools
const projectProp = {
  project: { type: 'string', description: 'Optional absolute path of the project root. Omit in Claude Code (it is detected automatically).' },
};

const QUIZ_ITEM = {
  type: 'object',
  properties: {
    context: { type: 'string', description: 'REQUIRED, 1-3 sentences: what the thing you ask about IS and what it does in this project, so the user can follow even if they haven\'t read the code (e.g. "Gates are the obstacles: two crystal pillars with a gap the drone flies through. GateSpawner creates them and recycles them off-screen.").' },
    question: { type: 'string', description: 'The question. One sentence, < 160 chars.' },
    options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: '2-4 short, plausible options (one clearly correct), each < 140 chars.' },
    answer: { type: 'integer', description: '0-based index of the correct option in `options`.' },
    explanation: { type: 'string', description: '1-2 sentences: why the right answer is right (and the tempting wrong one wrong). Shown after answering.' },
    lesson: { type: 'string', description: 'Optional mini-lesson (2-4 sentences) teaching the underlying technique/concept.' },
    deep_dive: { type: 'string', description: 'Recommended: a deeper explanation (~80-150 words, may include a tiny snippet from this project). Shown INSTANTLY when the user taps "Explain more", so they never wait for anyone.' },
    concept: { type: 'string', description: 'Short concept tag, e.g. "React useEffect cleanup", "SQL index", "Rigidbody2D body types".' },
    files: { type: 'array', items: { type: 'string' }, description: 'Files (paths, optionally path:line) the quiz is about.' },
    code: { type: 'string', description: 'Optional snippet (<= 12 lines) the question refers to.' },
    language: { type: 'string', description: 'Language of the snippet for highlighting, e.g. "ts".' },
    difficulty: { type: 'integer', enum: [1, 2, 3], description: '1 easy, 2 medium, 3 hard. Use suggested_difficulty from skillme_status.' },
  },
  required: ['context', 'question', 'options', 'answer', 'explanation', 'concept'],
};

const TOOLS = [
  {
    name: 'skillme_quiz',
    title: 'Push SkillMe quizzes',
    description:
      'Push 1-3 short multiple-choice quizzes (one per distinct idea) about code you just wrote/changed (or just read), so the user keeps up with you. ' +
      'Every quiz starts with a short `context` explaining what the thing is. Ask about the WHY / WHAT-IF / WHAT-HAPPENS (behaviour, trade-offs, edge cases, the technique used), never trivia like names. ' +
      'Quizzes are answered ONLY in the SkillMe Arena (a browser page): never ask them in chat. Just push them and keep working.',
    inputSchema: {
      type: 'object',
      properties: {
        quizzes: { type: 'array', items: QUIZ_ITEM, minItems: 1, maxItems: 3, description: '1 quiz for a small change; 2-3 (different files/ideas) after a big one.' },
        ...projectProp,
      },
      required: ['quizzes'],
    },
  },
  {
    name: 'skillme_feedback',
    title: 'Get fix requests',
    description: 'Fetch fix requests: bugs the user exposed by winning a challenge in the Arena (judged by the tutor). Fix them before continuing. Call it at natural pauses if hooks are not available. Everything else (answers, explanations, challenges) is handled in the Arena; you never answer it.',
    inputSchema: { type: 'object', properties: { ...projectProp } },
  },
  {
    name: 'skillme_correction',
    title: 'Record that the user caught you',
    description: 'Call this whenever the user corrects you: points out a bug, a wrong assumption, a bad approach, or wrong facts in your code/explanation, and they are right. Your codebase-knowledge score drops and the user earns XP. Be a good sport about it.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What you got wrong, in a few words.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files involved.' },
        severity: { type: 'integer', enum: [1, 2, 3], description: '1 nitpick, 2 real mistake, 3 serious bug/misunderstanding.' },
        ...projectProp,
      },
      required: ['summary'],
    },
  },
  {
    name: 'skillme_status',
    title: 'Scoreboard',
    description: 'Scoreboard (human understanding vs AI knowledge), Arena URL, how many quizzes are waiting, suggested difficulty and the user\'s weak concepts. Pass open=true to open the Arena in the user\'s browser.',
    inputSchema: {
      type: 'object',
      properties: { open: { type: 'boolean', description: 'Open the Arena in the browser.' }, ...projectProp },
    },
  },
  {
    name: 'skillme_track',
    title: 'Track AI file activity',
    description: 'For AI clients WITHOUT SkillMe hooks (Cursor, Codex, Gemini, Copilot...): report the files you read or wrote since the last call so knowledge scores stay accurate. Claude Code tracks this automatically — do not call it there.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              action: { type: 'string', enum: ['read', 'write'] },
              lines: { type: 'integer', description: 'Approximate lines added/changed (for write).' },
            },
            required: ['path', 'action'],
          },
        },
        ...projectProp,
      },
      required: ['files'],
    },
  },
  {
    name: 'skillme_settings',
    title: 'SkillMe settings',
    description: 'Change SkillMe settings: mode (arena = on, off), quiz cadence, auto-opening the Arena, pause/resume for this project.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['arena', 'off'] },
        auto_open_arena: { type: 'boolean', description: 'Open the Arena in the browser when quizzes arrive and nobody is watching.' },
        quiz_every_edits: { type: 'integer', minimum: 1, maximum: 50 },
        quiz_every_lines: { type: 'integer', minimum: 5, maximum: 2000 },
        max_pending: { type: 'integer', minimum: 1, maximum: 10 },
        stop_hook_quiz: { type: 'boolean', description: 'Ask for a final quiz before ending a turn with unquizzed changes (Claude Code).' },
        paused: { type: 'boolean', description: 'Pause/resume quizzes for this project.' },
        ...projectProp,
      },
    },
  },
];

function rootFromArgs(args) {
  if (args && typeof args.project === 'string' && args.project.trim()) return core.findRoot(args.project.trim());
  const files = (args && (args.files || [])) || [];
  const first = files.map((f) => (typeof f === 'string' ? f : f && f.path)).find((p) => p && path.isAbsolute(p.replace(/:\d+(-\d+)?$/, '')));
  if (first) return core.findRoot(first.replace(/:\d+(-\d+)?$/, ''));
  return core.defaultRoot();
}

function eventsBlock(s) {
  const ev = core.takeEvents(s);
  return ev.length ? `\n\n${core.describeEvents(ev, s)}` : '';
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args = {}) {
  const root = rootFromArgs(args);
  const slug = core.projectSlug(root);
  const cfg = core.getConfig();

  switch (name) {
    case 'skillme_quiz': {
      const st = core.loadState(root);
      if (cfg.mode === 'off' || st.paused) return text('SkillMe is paused/off for this project — skip quizzes and carry on.');
      const list = Array.isArray(args.quizzes) ? args.quizzes : args.question ? [args] : [];
      if (!list.length) return text('Pass `quizzes`: an array of 1-3 quiz objects.', true);
      const url = await ensureArena();
      const out = core.updateState(root, (s) => {
        core.refreshTotalFiles(s, root);
        const made = [], errors = [], expired = [];
        list.slice(0, 3).forEach((item, i) => {
          const r = core.pushQuiz(s, root, item || {});
          if (r.ok) { made.push(r.quiz); expired.push(...r.expired); }
          else errors.push(`quiz ${i + 1}: ${r.errors.join('; ')}`);
        });
        return { made, errors, expired, line: core.scoreLine(s), events: eventsBlock(s) };
      });
      if (!out.made.length) return text('Quiz rejected — fix and resend:\n- ' + out.errors.join('\n- '), true);
      const watching = core.viewerConnected(slug);
      let opened = false;
      if (!watching && cfg.autoOpenArena && !openedOnce && url) { openedOnce = true; opened = openArena(url, slug); }
      let msg = `Queued ${out.made.length} quiz${out.made.length > 1 ? 'zes' : ''} (${out.made.map((q) => '#' + q.n).join(', ')}) in the SkillMe Arena. `;
      msg += 'The user answers them there while you keep working. Never ask quizzes in chat and never discuss their answers; just continue your task.';
      if (!watching) {
        const link = url ? `${url}/?p=${slug}` : 'the Arena';
        msg += opened
          ? ` (The Arena wasn't open, so it was just opened in the user's browser: ${link}.)`
          : ` The user doesn't have the Arena open: mention the link once, in one line (${link}), then carry on.`;
      }
      if (out.errors.length) msg += `\n\nRejected (fix and resend these): ${out.errors.join(' | ')}`;
      if (out.expired.length) msg += `\n(${out.expired.length} older unanswered quiz expired.)`;
      msg += `\n\n${out.line}${out.events}`;
      return text(msg);
    }

    case 'skillme_feedback': {
      const r = core.updateState(root, (s) => ({ ev: core.takeEvents(s), s: JSON.parse(JSON.stringify(s)) }));
      const body = r.ev.length ? core.describeEvents(r.ev, r.s) : 'No fix requests.';
      return text(`${body}\n\n${core.scoreLine(r.s)}`);
    }

    case 'skillme_correction': {
      const r = core.updateState(root, (s) => ({ res: core.recordCorrection(s, root, args.summary, args.files, args.severity), line: core.scoreLine(s) }));
      return text(`Recorded: the user caught you (+${r.res.xp} XP for them, AI ${r.res.delta.ai}%). ` +
        `${r.res.newBadges.length ? 'They unlocked ' + r.res.newBadges.map((b) => b.name).join(', ') + '. ' : ''}` +
        `Acknowledge it with good humour in one line, then fix it.\n${r.line}`);
    }

    case 'skillme_status': {
      const url = await ensureArena();
      const s = core.updateState(root, (st) => { core.refreshTotalFiles(st, root); return JSON.parse(JSON.stringify(st)); });
      const sc = core.scores(s);
      if (args.open && url) openArena(url, slug);
      const pending = s.quizzes.filter((q) => q.status === 'pending');
      const lines = [
        core.scoreLine(s),
        `Arena: ${url ? `${url}/?p=${slug}` : 'offline'}${args.open ? ' (opened in browser)' : ''} · viewer ${core.viewerConnected(slug) ? 'connected' : 'not connected'} · mode ${cfg.mode}${s.paused ? ' (PAUSED)' : ''}`,
        `Accuracy: ${sc.accuracy ?? '–'}% over ${sc.answered} answers · best streak ${sc.bestStreak} · AI trust ${sc.trust}% (${sc.aiCorrections} corrections)`,
        `Codebase map: AI explored ${sc.explored}/${sc.totalFiles} files (${sc.mapPct}%)`,
        `suggested_difficulty: ${core.suggestedDifficulty(s)} · weak concepts: ${core.weakConcepts(s).join(', ') || 'none yet'}`,
        `Badges: ${sc.badges.map((b) => b.name).join(', ') || 'none yet'}`,
      ];
      if (pending.length) lines.push(`${pending.length} quiz(zes) waiting in the Arena: the user answers them there, never in chat.`);
      return text(lines.join('\n'));
    }

    case 'skillme_track': {
      const n = core.updateState(root, (s) => {
        let c = 0;
        for (const f of args.files || []) {
          if (f && f.path && core.trackActivity(s, root, f.path, f.action === 'write' ? 'write' : 'read', f.lines || 10)) c++;
        }
        const due = s.counters.editsSinceQuiz >= cfg.quizEveryEdits || s.counters.linesSinceQuiz >= cfg.quizEveryLines;
        return { c, due, files: s.counters.filesSinceQuiz.slice(), events: eventsBlock(s) };
      });
      let msg = `Tracked ${n.c} file(s).`;
      if (n.due && cfg.mode !== 'off') msg += ` Quiz due: push 1-3 short quizzes (one skillme_quiz call, each with \`context\`) about ${n.files.join(', ')}. They go to the Arena; don't ask them in chat.`;
      return text(msg + n.events);
    }

    case 'skillme_settings': {
      const patch = {};
      if (args.mode) patch.mode = args.mode === 'off' ? 'off' : 'arena';
      if (typeof args.auto_open_arena === 'boolean') patch.autoOpenArena = args.auto_open_arena;
      if (args.quiz_every_edits) patch.quizEveryEdits = args.quiz_every_edits;
      if (args.quiz_every_lines) patch.quizEveryLines = args.quiz_every_lines;
      if (args.max_pending) patch.maxPending = args.max_pending;
      if (typeof args.stop_hook_quiz === 'boolean') patch.stopHookQuiz = args.stop_hook_quiz;
      const next = Object.keys(patch).length ? core.setConfig(patch) : core.getConfig();
      let paused;
      if (typeof args.paused === 'boolean') {
        paused = core.updateState(root, (s) => { s.paused = args.paused; return s.paused; });
      } else paused = core.loadState(root).paused;
      return text(`Settings: mode=${next.mode}, quiz every ${next.quizEveryEdits} edits or ${next.quizEveryLines} lines, max pending ${next.maxPending}, stop-hook quiz ${next.stopHookQuiz ? 'on' : 'off'}; this project ${paused ? 'PAUSED' : 'active'}.`);
    }

    default:
      return text(`Unknown tool ${name}`, true);
  }
}

// ============================================================== JSON-RPC over stdio
const KNOWN_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: KNOWN_VERSIONS.includes(params && params.protocolVersion) ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'skillme', title: 'SkillMe — code quiz duel', version: core.VERSION },
          instructions:
            'SkillMe turns coding with an AI into a friendly duel. While you write code, push short quizzes with context (skillme_quiz). ' +
            'The user answers them only in the SkillMe Arena (a browser page) and a separate tutor AI handles their questions and challenges, so never quiz or tutor in chat. ' +
            'Fix any fix request SkillMe relays, and call skillme_correction when the user catches a mistake of yours in chat.',
        };
        ensureArena().catch(() => {});
        break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'tools/call': {
        const p = params || {};
        try { result = await callTool(p.name, p.arguments || {}); } catch (e) {
          log('tool error', e.stack || e);
          result = text(`SkillMe error: ${e.message || e}`, true);
        }
        break;
      }
      case 'resources/list': result = { resources: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      default:
        if (!isRequest) return; // notifications (initialized, cancelled, ...) need no reply
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
    if (isRequest) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

if (require.main === module) {
  if (process.argv.includes('--arena')) {
    // Standalone arena (no MCP): `node server/index.js --arena`
    ensureArena().then((u) => {
      log('arena:', u || 'could not bind');
      if (arenaServer) arenaServer.ref();
      if (u && process.argv.includes('--open')) openArena(u, null);
    });
  } else {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
        for (const m of Array.isArray(msg) ? msg : [msg]) handleRpc(m);
      }
    });
    process.stdin.on('end', () => process.exit(0));
  }
}

module.exports = { callTool, ensureArena, TOOLS };

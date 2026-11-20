#!/usr/bin/env node
'use strict';
/**
 * End-to-end smoke test: MCP server over stdio + Arena HTTP API + tutor (against a fake OpenRouter) + Claude Code hooks + statusline.
 * Uses a throwaway SKILLME_HOME and project folder. Run: node test/smoke.js
 */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillme-test-'));
const HOME = path.join(tmp, 'home');
const PROJ = path.join(tmp, 'proj');
const PORT = 47000 + Math.floor(Math.random() * 900);
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true });
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'src', 'auth.js'), 'module.exports = {}\n');
fs.writeFileSync(path.join(PROJ, 'src', 'db.js'), 'module.exports = {}\n');
fs.writeFileSync(path.join(PROJ, 'README.md'), '# demo\n');
const setConfig = (cfg) => fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(cfg));
// Never let the test touch a real AI: tutor off unless a test enables the fake one.
const BASE = { tutor: 'off', autoOpenArena: false }; // never open real browser windows from tests
setConfig(BASE);
process.env.SKILLME_HOME = HOME; // lets the test read answer keys from the state file (the browser never gets them)
// ---------------------------------------------------------------- fake OpenRouter (tests never call the real one)
const OR_PORT = 48000 + Math.floor(Math.random() * 900);
const GOOD_KEY = 'sk-or-v1-test-good-key-000000000001';
const fake = { mode: 'ok', calls: [] };
const orSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const good = req.headers.authorization === `Bearer ${GOOD_KEY}`;
    if (req.url === '/api/v1/key') return good ? send(200, { data: { label: 'test' } }) : send(401, { error: { message: 'User not found.', code: 401 } });
    if (req.url !== '/api/v1/chat/completions') return send(404, { error: { message: 'not found' } });
    if (!good) return send(401, { error: { message: 'User not found.', code: 401 } });
    const body = JSON.parse(b);
    fake.calls.push(body);
    if (fake.mode === 'fail') return send(500, { error: { message: 'fake upstream failure' } });
    const prompt = body.messages.map((m) => m.content).join('\n');
    const reply = /impartial judge/.test(prompt)
      ? { verdict: /I am right/.test(prompt) ? 'human_right' : 'ai_right', explanation: 'Fake judge: I checked the code.', fix: /real bug/.test(prompt) ? 'src/db.js:1 — await db.connect() before the first query.' : null }
      : { answer: 'Fake tutor: here is a deeper explanation with an example.' };
    send(200, { id: 'gen-1', model: 'fake/model-1', choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify(reply) + '\n```' }, finish_reason: 'stop' }] });
  });
});
orSrv.listen(OR_PORT, '127.0.0.1');

const env = { ...process.env, SKILLME_HOME: HOME, SKILLME_PROJECT: PROJ, CLAUDE_PROJECT_DIR: PROJ, SKILLME_PORT: String(PORT), SKILLME_TUTOR_BASE_URL: `http://127.0.0.1:${OR_PORT}/api/v1` };
delete env.SKILLME_DISABLE;
delete env.OPENROUTER_API_KEY; // a developer's real key must never be used by the test

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

// ---------------------------------------------------------------- MCP client
const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', nextId = 1;
const waiting = {};
srv.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    if (waiting[msg.id]) { waiting[msg.id](msg); delete waiting[msg.id]; }
  }
});
let stderr = '';
srv.stderr.on('data', (c) => (stderr += c));
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + method + '\n' + stderr)), 8000);
    waiting[id] = (m) => { clearTimeout(t); resolve(m); };
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  assert(!r.error, JSON.stringify(r.error));
  return { text: r.result.content[0].text, isError: !!r.result.isError };
}

// ---------------------------------------------------------------- helpers
function hook(mode, input, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hook.js'), mode], { env: { ...env, ...extraEnv }, input: JSON.stringify({ cwd: PROJ, ...input }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
function httpReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: b }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(150);
  }
}
const quiz = (extra = {}) => ({
  context: 'login() in src/auth.js checks a password against the bcrypt hash stored for the user.',
  question: 'Why does login() hash the password with bcrypt before comparing?',
  options: ['Because bcrypt is faster', 'bcrypt.compare hashes the input with the stored salt and compares safely', 'To encrypt it for the DB', 'It does not'],
  answer: 1,
  explanation: 'compare() re-hashes with the salt embedded in the stored hash; you never decrypt a hash.',
  lesson: 'Password hashes are one-way. bcrypt stores salt+cost in the hash string.',
  deep_dive: 'A bcrypt hash looks like $2b$10$<salt><hash>. compare() reads the cost and salt from it, hashes the candidate the same way, and compares in constant time.',
  concept: 'password hashing',
  files: ['src/auth.js:3'],
  difficulty: 2,
  ...extra,
});

(async () => {
  console.log('SkillMe smoke test (port ' + PORT + ')');

  // ---- MCP handshake
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.strictEqual(init.result.serverInfo.name, 'skillme');
  assert.strictEqual(init.result.protocolVersion, '2025-06-18');
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['skillme_quiz', 'skillme_feedback', 'skillme_correction', 'skillme_status', 'skillme_track', 'skillme_settings']) assert(names.includes(n), n);
  assert(!names.includes('skillme_answer') && !names.includes('skillme_resolve_challenge'), 'no tools for answering in the coding session');
  assert(!names.includes('skillme_brief'), 'no brief');
  assert.strictEqual(names.length, 6);
  const unknown = await rpc('foo/bar', {});
  assert.strictEqual(unknown.error.code, -32601);
  ok('MCP initialize / tools/list (6 tools, none for answering in chat, no brief) / unknown method');

  // ---- hooks: session start + AI activity
  const ss = hook('session-start', { hook_event_name: 'SessionStart' });
  assert(!/skillme_brief/.test(ss.hookSpecificOutput.additionalContext) && /context/.test(ss.hookSpecificOutput.additionalContext));
  assert.strictEqual(hook('session-start', {}, { SKILLME_DISABLE: '1' }), null, 'opt-out switch');
  ok('SessionStart hook injects rules (context, no brief); hooks stay silent when SKILLME_DISABLE=1');

  assert.strictEqual(hook('post-tool-use', { tool_name: 'Read', tool_input: { file_path: path.join(PROJ, 'src', 'db.js') } }), null);
  assert.strictEqual(hook('post-tool-use', { tool_name: 'Read', tool_input: { file_path: path.join(os.tmpdir(), 'outside.js') } }), null);
  let h = hook('post-tool-use', { tool_name: 'Write', tool_input: { file_path: path.join(PROJ, 'src', 'auth.js'), content: 'a\n'.repeat(12) } });
  assert.strictEqual(h, null, 'no nudge after 1 small edit');
  h = hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'src', 'auth.js'), old_string: 'x', new_string: 'y\n'.repeat(5) } });
  const nudge = h && h.hookSpecificOutput.additionalContext;
  assert(nudge && /quizzes due/.test(nudge), 'nudge after 2 edits');
  assert(/Arena/.test(nudge) && /never ask/.test(nudge) && !/AskUserQuestion/.test(nudge), nudge);
  assert(!/skillme_brief/.test(nudge) && /context/.test(nudge) && !/\p{Extended_Pictographic}/u.test(nudge), nudge);
  h = hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'src', 'auth.js'), old_string: 'x', new_string: 'z\n'.repeat(60) } });
  assert.strictEqual(h, null, 'nudge rate-limited');
  ok('PostToolUse hook tracks reads/writes, nudges every 2 edits (Arena-only, context, no emoji), rate-limits');

  // ---- status
  let r;
  let st = await tool('skillme_status', {});
  assert(/Battle 1: You 100 HP vs Claude 100 HP/.test(st.text) && /understanding \d+% vs AI knowledge \d+%/.test(st.text) && st.text.includes(`127.0.0.1:${PORT}`) && !/\p{Extended_Pictographic}/u.test(st.text), st.text);
  assert(/explored 2\/3/.test(st.text), 'map counts files: ' + st.text);
  ok('skillme_status shows scoreboard and Arena URL');

  // ---- validation
  r = await tool('skillme_quiz', { quizzes: [quiz({ options: ['only one'] })] });
  assert(r.isError && /2-4/.test(r.text));
  r = await tool('skillme_quiz', { quizzes: [quiz({ question: 'x'.repeat(300) })] });
  assert(r.isError && /short/.test(r.text));
  r = await tool('skillme_quiz', { quizzes: [quiz({ context: '' })] });
  assert(r.isError && /context is required/.test(r.text));
  ok('quiz validation rejects bad/long quizzes and quizzes without context');

  // ---- quizzes go to the Arena only (batch of 2)
  r = await tool('skillme_quiz', { quizzes: [quiz(), quiz({ question: 'What does login() return for an unknown email?', concept: 'auth errors' })] });
  assert(/Queued 2 quizzes/.test(r.text) && /in the SkillMe Arena/.test(r.text) && /Never ask quizzes in chat/.test(r.text), r.text);
  assert(!/AskUserQuestion|INLINE|correct [A-D]/.test(r.text), 'nothing to ask or grade in chat, no answers leaked to the coding AI');
  assert(/mention the link once/.test(r.text), 'Arena not open + auto-open off: just mention the link');
  ok('quizzes go to the Arena only: no chat delivery, no answer keys in the tool result');

  // ---- arena basics
  let s = await httpReq('GET', '/api/ping');
  assert.strictEqual(s.body.app, 'skillme');
  s = await httpReq('GET', '/');
  assert(String(s.body).includes('SkillMe Arena') && !/\p{Extended_Pictographic}/u.test(String(s.body)), 'page has SVG icons, no emoji');
  s = await httpReq('GET', '/api/state');
  const slug = s.body.project.slug;
  const answerKey = (id) => require(path.join(ROOT, 'server', 'core.js')).loadStateBySlug(slug).quizzes.find((q) => q.id === id).answer;
  const first = s.body.pending[0];
  s = await httpReq('POST', '/api/answer', { p: slug, quizId: first.id, choice: answerKey(first.id) });
  assert(s.body.correct && s.body.xp > 0, 'answered correctly in the Arena');
  s = await httpReq('GET', '/api/state');
  assert(s.body.scores.human > 0, 'human score rose after correct answer');
  assert(!('brief' in s.body) && !('feed' in s.body) && !('units' in s.body), 'no brief, feed or knowledge map in the Arena payload');
  assert(s.body.tutor && s.body.tutor.available === false && s.body.tutor.state === 'off', 'tutor off in config');
  assert(s.body.allBadges.every((b) => !('icon' in b)), 'badges carry no emoji icons');
  ok('Arena serves page + state (no brief, no feed) with the tutor status');

  s = await httpReq('GET', `/api/state?p=does-not-exist`);
  assert.strictEqual(s.body.project.slug, slug);
  ok('stale/unknown project links fall back to the most recent project');

  // Answer the second (still pending) quiz wrong in the Arena.
  r = await tool('skillme_quiz', { quizzes: [quiz({ question: 'What happens if the DB is down when login() runs?', concept: 'error handling', difficulty: 1 })] });
  assert(/in the SkillMe Arena/.test(r.text) && !/mention the link/.test(r.text), 'viewer connected: nothing to mention');
  s = await httpReq('GET', `/api/state?p=${slug}`);
  const pq = s.body.pending.find((q) => q.question.startsWith('What happens if the DB'));
  assert(pq && pq.answer === undefined && pq.deepDive === undefined, 'answer and deep dive not leaked to the browser');
  assert(pq.context.startsWith('login()'), 'context shown with the pending quiz');
  const wrongIdx = (answerKey(pq.id) + 1) % pq.options.length;
  await httpReq('POST', '/api/seen', { p: slug, quizId: pq.id });
  s = await httpReq('POST', '/api/answer', { p: slug, quizId: pq.id, choice: wrongIdx });
  assert.strictEqual(s.body.correct, false);
  assert(s.body.explanation && s.body.lesson && s.body.deepDive, 'explanation, lesson and deep dive revealed');
  ok('Arena quiz: no answer leak, wrong answer reveals answer + lesson + deep dive');

  s = await httpReq('POST', '/api/answer', { p: slug, quizId: pq.id, choice: 0 });
  assert(s.body.ok === false);
  const bad = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/answer', method: 'POST', headers: { 'Content-Type': 'text/plain', Connection: 'close' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => {});
    req.end('{}');
  });
  assert.strictEqual(bad, 415);
  const badHost = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { Host: 'evil.example.com', Connection: 'close' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => {});
  });
  assert.strictEqual(badHost, 403);
  ok('Arena rejects double answers, non-JSON posts, foreign Host headers');

  // ---- "Explain more" with a deep dive: instant, never reaches the coding session
  s = await httpReq('POST', '/api/explain', { p: slug, quizId: pq.id });
  assert.strictEqual(s.body.routed, 'instant');
  assert.strictEqual(hook('post-tool-use', { tool_name: 'Read', tool_input: { file_path: path.join(PROJ, 'README.md') } }), null);
  ok('"Explain more" is instant from the pre-written deep dive (main session untouched)');

  // ---- tutor unavailable: questions and challenges WAIT in the Arena (never go to the coding session)
  s = await httpReq('POST', '/api/ask', { p: slug, quizId: pq.id, note: 'Why not retry the DB call?' });
  assert(s.body.ok && s.body.waiting, JSON.stringify(s.body));
  s = await httpReq('POST', '/api/challenge', { p: slug, quizId: pq.id, note: 'I am right, and this hides a real bug' });
  assert(!s.body.ok && /tutor/.test(s.body.error), 'one tutor job per quiz at a time');
  r = await tool('skillme_quiz', { quizzes: [quiz({ question: 'Which status code does login() send on a bad password?', concept: 'http status' })] });
  s = await httpReq('GET', '/api/state?p=' + slug);
  const q3 = s.body.pending.find((q) => q.concept === 'http status');
  await httpReq('POST', '/api/answer', { p: slug, quizId: q3.id, choice: (answerKey(q3.id) + 1) % 4 });
  s = await httpReq('POST', '/api/challenge', { p: slug, quizId: q3.id, note: 'I am right, and this hides a real bug' });
  assert(s.body.ok && s.body.waiting, JSON.stringify(s.body));
  s = await httpReq('GET', '/api/state?p=' + slug);
  assert(s.body.history.find((x) => x.id === pq.id).tutorWaiting, 'question shown as waiting');
  assert.strictEqual(hook('post-tool-use', { tool_name: 'Read', tool_input: { file_path: path.join(PROJ, 'README.md') } }), null);
  assert.strictEqual(hook('user-prompt', { prompt: 'continue please' }), null);
  r = await tool('skillme_feedback', {});
  assert(/No fix requests/.test(r.text), r.text);
  ok('tutor off: questions and challenges wait in the Arena; nothing reaches the coding session');

  // ---- tutor on but no key: still waiting; a rejected key keeps it waiting (retries not used up)
  setConfig({ ...BASE, tutor: 'auto' });
  s = await httpReq('GET', '/api/state?p=' + slug);
  assert.strictEqual(s.body.tutor.state, 'no_key');
  assert.strictEqual(s.body.tutor.model, 'openrouter/auto', 'Auto Router by default');
  s = await httpReq('POST', '/api/tutor', { openrouterKey: 'not-a-key' });
  assert(!s.body.ok && /sk-or-/.test(s.body.error), 'key format checked');
  s = await httpReq('POST', '/api/tutor', { openrouterKey: 'sk-or-v1-wrong-key-000000000002' });
  assert(s.body.ok && s.body.tutor.keySource === 'saved');
  await until(async () => (await httpReq('GET', '/api/state?p=' + slug)).body.tutor.state === 'bad_key');
  s = await httpReq('GET', '/api/state?p=' + slug);
  assert(s.body.history.find((x) => x.id === pq.id).tutorWaiting, 'still waiting with a rejected key');
  assert.strictEqual(fake.calls.length, 0, 'no completion was accepted with the wrong key');
  ok('tutor: no key -> waits; malformed key refused; rejected key -> "bad_key", work keeps waiting');

  // ---- a good key saved from the Arena: waiting work runs automatically
  const before = (await httpReq('GET', '/api/state?p=' + slug)).body.scores;
  s = await httpReq('POST', '/api/tutor', { openrouterKey: GOOD_KEY });
  assert(s.body.ok);
  const done = await until(async () => {
    const st2 = (await httpReq('GET', '/api/state?p=' + slug)).body;
    const a = st2.history.find((x) => x.id === pq.id), c = st2.history.find((x) => x.id === q3.id);
    return a && c && a.thread.some((m) => m.role === 'tutor') && c.challenge && c.challenge.status !== 'open' && { a, c, st2 };
  });
  const tmsg = done.a.thread.find((m) => m.role === 'tutor');
  assert(/Fake tutor/.test(tmsg.text) && tmsg.model === 'fake/model-1', 'answer stored with the model that wrote it');
  assert.strictEqual(done.c.challenge.status, 'human_right');
  assert(/db.connect/.test(done.c.challenge.fix));
  assert(done.st2.scores.ai < before.ai && done.st2.scores.xp >= before.xp + 30 && done.st2.scores.badges.some((b) => b.id === 'gotcha'));
  const sent = fake.calls.map((c) => c.messages.map((m) => m.content).join('\n')).join('\n');
  assert(fake.calls.every((c) => c.model === 'openrouter/auto'), 'requests use the Auto Router');
  assert(/src\/auth\.js \(lines 1-/.test(sent) && /1\| /.test(sent), 'the quiz\'s file is sent with line numbers');
  assert(!JSON.stringify(done.st2).includes(GOOD_KEY), 'the key never reaches the Arena page');
  ok('good key saved in the Arena: queued question answered and challenge judged via OpenRouter (+30 XP, AI drops)');

  h = hook('stop', { stop_hook_active: false });
  assert(h && h.decision === 'block' && /FIX REQUEST/.test(h.reason) && /db.connect/.test(h.reason), JSON.stringify(h));
  assert(!h.reason.includes(GOOD_KEY));
  assert.strictEqual(hook('post-tool-use', { tool_name: 'Read', tool_input: { file_path: path.join(PROJ, 'README.md') } }), null, 'fix delivered once');
  ok('won challenge with a real bug: the fix request is the only thing sent to the coding session (once)');

  s = await httpReq('POST', '/api/tutor', { model: 'claude-opus-5-5' });
  assert(!s.body.ok, 'bare model names (no vendor/) refused');
  s = await httpReq('POST', '/api/tutor', { model: 'anthropic/claude-sonnet-5.5' });
  assert(s.body.ok && s.body.tutor.model === 'anthropic/claude-sonnet-5.5');
  s = await httpReq('POST', '/api/ask', { p: slug, quizId: pq.id, note: 'And with a circuit breaker?' });
  assert(s.body.ok && !s.body.waiting && s.body.job === 'ask', JSON.stringify(s.body));
  await until(async () => (await httpReq('GET', '/api/state?p=' + slug)).body.history.find((x) => x.id === pq.id).thread.filter((m) => m.role === 'tutor').length === 2);
  assert.strictEqual(fake.calls[fake.calls.length - 1].model, 'anthropic/claude-sonnet-5.5', 'chosen model used');
  ok('tutor answers follow-ups immediately; the model picked in the Arena is used');

  // ---- what the tutor may read: only project files, never secrets or anything outside
  fs.writeFileSync(path.join(PROJ, '.env'), 'TOKEN=secret');
  fs.writeFileSync(path.join(tmp, 'outside.js'), 'outside');
  const tutorMod = require(path.join(ROOT, 'server', 'tutor.js'));
  const ex = tutorMod.excerpts(PROJ, ['src/auth.js:2', '.env', '../outside.js', 'src/missing.js']);
  assert(/src\/auth\.js/.test(ex) && !/TOKEN|outside/.test(ex), ex);
  ok('tutor excerpts: only the quiz\'s project files, never .env or files outside the project');

  // ---- a failing tutor retries, then gives up inside the Arena
  fake.mode = 'fail';
  r = await tool('skillme_quiz', { quizzes: [quiz({ question: 'Why is the session cookie httpOnly?', concept: 'cookies' })] });
  s = await httpReq('GET', '/api/state?p=' + slug);
  const q4 = s.body.pending.find((q) => q.concept === 'cookies');
  await httpReq('POST', '/api/answer', { p: slug, quizId: q4.id, choice: (answerKey(q4.id) + 1) % 4 });
  await httpReq('POST', '/api/challenge', { p: slug, quizId: q4.id, note: 'I think B is also right' });
  const gaveUp = await until(async () => {
    const q = (await httpReq('GET', '/api/state?p=' + slug)).body.history.find((x) => x.id === q4.id);
    return q && !q.tutorBusy && q;
  }, 15000);
  assert.strictEqual(gaveUp.challenge, null, 'challenge withdrawn so it can be retried');
  assert(gaveUp.thread.some((m) => m.role === 'system' && /couldn't judge/.test(m.text)));
  assert.strictEqual(hook('post-tool-use', { tool_name: 'Read', tool_input: { file_path: path.join(PROJ, 'README.md') } }), null, 'still nothing for the coding session');
  fake.mode = 'ok';
  s = await httpReq('POST', '/api/tutor', { openrouterKey: '' });
  assert(s.body.ok && s.body.tutor.state === 'no_key', 'key removed');
  setConfig(BASE);
  ok('failing tutor retries, then withdraws the challenge in the Arena (never falls back to chat); key can be removed');

  // ---- correction
  r = await tool('skillme_correction', { summary: 'forgot to await db.connect()', files: ['src/db.js'], severity: 2 });
  assert(/caught you/.test(r.text) && /AI -\d+%/.test(r.text), r.text);
  ok('skillme_correction lowers AI knowledge and rewards the user');

  // ---- user prompt hook
  h = hook('user-prompt', { prompt: "that's wrong, the token should be refreshed first" });
  assert(/skillme_correction/.test(h.hookSpecificOutput.additionalContext));
  assert.strictEqual(hook('user-prompt', { prompt: 'add a dark mode toggle please' }), null);
  ok('UserPromptSubmit hook reminds to log corrections only when relevant');

  // ---- stop hook: final quizzes
  hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'src', 'db.js'), old_string: 'a', new_string: 'b\n'.repeat(12) } });
  h = hook('stop', { stop_hook_active: false });
  assert(h && h.decision === 'block' && /final quizzes/.test(h.reason), JSON.stringify(h));
  assert.strictEqual(hook('stop', { stop_hook_active: true }), null);
  ok('Stop hook asks for final quizzes once (no loop)');

  // ---- feedback / track / settings
  r = await tool('skillme_track', { files: [{ path: path.join(PROJ, 'src', 'db.js'), action: 'write', lines: 80 }] });
  assert(/Quiz due/.test(r.text), r.text);
  r = await tool('skillme_feedback', {});
  assert(/No fix requests/.test(r.text), r.text);
  r = await tool('skillme_settings', { paused: true });
  assert(/PAUSED/.test(r.text));
  r = await tool('skillme_quiz', { quizzes: [quiz()] });
  assert(/paused/.test(r.text));
  assert.strictEqual(hook('stop', { stop_hook_active: false }), null, 'paused: no stop block');
  await tool('skillme_settings', { paused: false });
  ok('skillme_track (non-Claude clients), feedback, pause/resume');

  // ---- queue expiry
  for (let i = 0; i < 3; i++) await tool('skillme_quiz', { quizzes: [quiz({ question: `Q${i}a: what does line ${i} do on error?` }), quiz({ question: `Q${i}b: why is line ${i} async?` })] });
  s = await httpReq('GET', `/api/state?p=${slug}`);
  assert(s.body.pending.length <= 6, 'queue capped at 6');
  ok('pending queue stays bounded (old quizzes expire)');

  // ---- restart: replay the same quizzes
  const core = require(path.join(ROOT, 'server', 'core.js'));
  const beforeRs = (await httpReq('GET', `/api/state?p=${slug}`)).body;
  const total = core.loadStateBySlug(slug).quizzes.length;
  s = await httpReq('POST', '/api/restart', { p: slug });
  assert(s.body.ok && s.body.count === total, JSON.stringify(s.body));
  s = await httpReq('GET', `/api/state?p=${slug}`);
  assert.strictEqual(s.body.pending.length, total, 'every quiz is back');
  assert.strictEqual(s.body.history.length, 0);
  assert(s.body.pending.every((q) => q.replay && q.thread.length === 0 && !q.challenge && q.answer === undefined), 'clean replays, answers still hidden');
  assert.deepStrictEqual(s.body.pending.map((q) => q.n), [...s.body.pending.map((q) => q.n)].sort((a, b) => a - b), 'original order');
  assert(s.body.scores.xp === beforeRs.scores.xp && s.body.scores.badges.length === beforeRs.scores.badges.length, 'XP and badges kept');
  assert(s.body.scores.human === 0 && s.body.scores.streak === 0 && s.body.scores.answered === 0, 'understanding, streak and accuracy reset');
  assert(s.body.battle.hp.human === 100 && s.body.battle.hp.ai === 100 && !s.body.battle.over, 'a restart is a fresh battle');
  r = await tool('skillme_quiz', { quizzes: [quiz({ question: 'After a restart, does a new quiz push out the replays?' })] });
  s = await httpReq('GET', `/api/state?p=${slug}`);
  assert.strictEqual(s.body.pending.length, total + 1, 'replays never expire to make room');
  ok('restart replays every quiz in order (XP and badges kept, the rest reset); replays never expire');

  // ---- save-in-project toggle
  const localFile = path.join(PROJ, '.claude', 'skillme', 'state.json');
  const homeFile = path.join(HOME, 'projects', slug, 'state.json');
  assert(fs.existsSync(homeFile) && !fs.existsSync(localFile));
  s = await httpReq('POST', '/api/storage', { p: slug, inProject: true });
  assert(s.body.ok && s.body.inProject, JSON.stringify(s.body));
  assert(fs.existsSync(localFile) && !fs.existsSync(homeFile), 'data moved into <project>/.claude/skillme');
  s = await httpReq('GET', `/api/state?p=${slug}`);
  assert(s.body.storage.inProject && s.body.pending.length === total + 1, 'Arena still finds the project and its quizzes');
  h = hook('post-tool-use', { tool_name: 'Read', tool_input: { file_path: path.join(PROJ, 'src', 'db.js') } });
  assert(JSON.parse(fs.readFileSync(localFile, 'utf8')).units['src/db.js'].reads > 0, 'hooks write to the project copy');
  assert(core.listProjects().some((p) => p.slug === slug), 'still listed in the project picker');
  s = await httpReq('POST', '/api/storage', { p: slug, inProject: false });
  assert(s.body.ok && !s.body.inProject && fs.existsSync(homeFile) && !fs.existsSync(localFile), 'moved back');
  ok('save-in-project toggle moves the quiz data into .claude/skillme and back; hooks and the Arena follow it');

  // ---- the window app (never launched by the test)
  const desktop = require(path.join(ROOT, 'server', 'app.js'));
  assert(/^\d+\.\d+\.\d+$/.test(desktop.ELECTRON_VERSION), 'Electron pinned to an exact version');
  assert(fs.existsSync(path.join(ROOT, 'desktop', 'main.js')) && fs.existsSync(path.join(ROOT, 'desktop', 'preload.js')));
  const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  assert(/contextIsolation: true/.test(mainSrc) && /nodeIntegration: false/.test(mainSrc) && /sandbox: true/.test(mainSrc), 'locked-down renderer');
  assert(/frame: false/.test(mainSrc) && /skillme:window/.test(mainSrc), 'frameless: the page draws the title bar and its buttons');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.js'), 'utf8');
  assert(['minimize', 'toggleMaximize', 'close', 'onMaximized'].every((k) => preloadSrc.includes(k + ':')), 'window controls exposed to the page');
  s = await httpReq('GET', '/');
  const page = String(s.body);
  assert(/Claude/.test(page) && /stageReact/.test(page), 'RPG stage with Claude');
  ok('window app: pinned runtime, locked-down frameless window with its own title bar; the page has the RPG stage');

  // ---- ready for other people: install the window app and copy the status line from the Arena; no machine paths
  s = await httpReq('GET', `/api/state?p=${slug}`);
  const appState = s.body.app;
  assert(appState && appState.installed === false && appState.installing === false, 'window app status in the Arena state');
  const slPath = (appState.statusline.match(/^node "(.+)"$/) || [])[1];
  assert(slPath && fs.existsSync(slPath) && /scripts\/statusline\.js$/.test(slPath), 'status line command points at this copy');
  s = await httpReq('POST', '/api/app', { p: slug, action: 'open' });
  assert(s.body.ok === false && /not installed/.test(s.body.error), 'open without the runtime explains why');
  s = await httpReq('POST', '/api/app', { p: slug, action: 'nope' });
  assert.strictEqual(s.status, 400);
  assert(/id="appBox"/.test(page) && /'\/api\/app'/.test(page) && /id="slCopy"/.test(page), 'menu installs the window app and copies the status line');
  const PLUGIN_DIR = path.join(__dirname, '..');
  const readJ = (p) => JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, p), 'utf8'));
  const versions = [readJ('package.json').version, readJ('.claude-plugin/plugin.json').version, readJ('.claude-plugin/marketplace.json').plugins[0].version, readJ('desktop/package.json').version, core.VERSION];
  assert(versions.every((v) => v === versions[0]), 'one version everywhere: ' + versions.join(', '));
  assert(fs.existsSync(path.join(PLUGIN_DIR, 'LICENSE')) && readJ('.claude-plugin/plugin.json').repository, 'license and repository link');
  const shipped = ['README.md', 'integrations/README.md', 'integrations/AGENTS.md', 'docs/gui-atlas-prompts.md', 'scripts/cli.js', 'skills/skillme/SKILL.md'];
  const machinePaths = shipped.filter((p) => /\b[A-Z]:[\\/](?!path\b)(?!tools\/SkillMe)|\/Users\/[a-z]|\\Users\\/i.test(fs.readFileSync(path.join(PLUGIN_DIR, p), 'utf8')));
  assert.deepStrictEqual(machinePaths, [], 'docs use placeholders, not this machine\'s paths');
  ok(`ready to share: window app and status line from the Arena menu; v${versions[0]} everywhere; MIT; no machine paths in the docs`);

  // ---- the art: served by name only, and every sprite the page uses exists
  s = await httpReq('GET', '/assets/sprites/manifest.json');
  const sprites = s.body;
  assert(s.status === 200 && Object.keys(sprites).length > 100 && sprites['hero-idle'] && sprites['claude-idle'], 'sprite manifest');
  const png = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: '/assets/sprites/claude-angry.png' }, (res) => { res.resume(); resolve([res.statusCode, res.headers['content-type']]); }));
  assert.deepStrictEqual(png, [200, 'image/png']);
  for (const p of ['/assets/sprites/../core.js', '/assets/sprites/%2e%2e%2fcore.js', '/assets/sprites/..%5Cindex.js', '/assets/sprites/sub/x.png']) {
    assert.strictEqual((await httpReq('GET', p)).status, 404, 'refused: ' + p);
  }
  const used = new Set([...page.matchAll(/\/assets\/sprites\/([a-z0-9_-]+)\.png/gi)].map((m) => m[1]));
  for (const m of page.matchAll(/(?:SPR|px|pic)\('([a-z0-9_-]+)'/gi)) used.add(m[1]);
  for (const m of page.matchAll(/'((?:hero|claude|icon|fx|badge|emblem)-[a-z0-9_-]+)'/gi)) used.add(m[1]);
  const fallbacks = Object.fromEntries([...(page.match(/const NEW_ART = \{([\s\S]*?)\};/) || ['', ''])[1].matchAll(/'([a-z0-9_-]+)':\s*'([a-z0-9_-]+)'/g)].map((m) => [m[1], m[2]]));
  assert(Object.keys(fallbacks).length >= 10, 'sheet-9 fallbacks declared');
  const missing = [...used].filter((n) => !sprites[n] && !(fallbacks[n] && sprites[fallbacks[n]]));
  assert.deepStrictEqual(missing, [], 'sprites the page uses but the build did not produce');
  ok(`art: ${Object.keys(sprites).length} sprites served by name only (no paths); all ${used.size} the page uses exist`);

  // ---- the look switch: game look by default, a classic look with a line-icon twin for every icon
  assert(/id="lookBtn"/.test(page) && /function setLook\(/.test(page), 'look toggle button');
  assert(/store\.get\('look', 'game'\) === 'classic'/.test(page), 'the game look is the default');
  const lineNames = new Set([...(page.match(/const LINE = \{([\s\S]*?)\n\};/) || ['', ''])[1].matchAll(/^\s+([a-zA-Z]+):/gm)].map((m) => m[1]));
  const lineFor = [...(page.match(/const LINE_FOR = \{([\s\S]*?)\n\};/) || ['', ''])[1].matchAll(/'([a-z0-9_-]+)':\s*'([a-zA-Z]+)\*?'/g)];
  assert(lineFor.length > 40, 'line icons mapped');
  assert.deepStrictEqual(lineFor.filter((m) => !lineNames.has(m[2])).map((m) => m[1]), [], 'line icons the classic look needs');
  assert.deepStrictEqual(lineFor.filter((m) => !sprites[m[1]]).map((m) => m[1]), [], 'line-icon twins of real sprites');
  const pxNames = new Set([...page.matchAll(/(?:px|pic)\('([a-z0-9_-]+)'/g)].map((m) => m[1]));
  assert.deepStrictEqual([...pxNames].filter((n) => !lineFor.some((m) => m[1] === n)), [], 'every icon has a classic twin');
  ok(`look switch: game look by default, classic look with ${lineFor.length} line icons`);

  // ---- the battle: 100 HP each, blows from answers, skips, expiry, challenges and corrections; KO; rematch
  const D = core.DAMAGE;
  s = await httpReq('POST', '/api/battle', { p: slug });
  assert(s.body.ok && s.body.battle.hp.human === 100 && s.body.battle.hp.ai === 100, 'new battle at full HP');
  const battleNo = s.body.battle.n;
  let st0 = (await httpReq('GET', `/api/state?p=${slug}`)).body;
  const right = st0.pending[0], wrong = st0.pending[1];
  s = await httpReq('POST', '/api/answer', { p: slug, quizId: right.id, choice: answerKey(right.id) });
  assert(s.body.hit && s.body.hit.target === 'ai' && s.body.hit.damage >= D.right(right.difficulty), JSON.stringify(s.body.hit));
  assert.strictEqual(s.body.battle.hp.ai, 100 - s.body.hit.damage, 'your right answer hits Claude');
  s = await httpReq('POST', '/api/answer', { p: slug, quizId: wrong.id, choice: (answerKey(wrong.id) + 1) % wrong.options.length });
  assert(s.body.hit.target === 'human' && s.body.hit.damage === D.wrong(wrong.difficulty) && s.body.battle.hp.human === 100 - D.wrong(wrong.difficulty), 'a wrong answer lets Claude hit you');
  const hpBeforeSkip = s.body.battle.hp.human;
  st0 = (await httpReq('GET', `/api/state?p=${slug}`)).body;
  await httpReq('POST', '/api/skip', { p: slug, quizId: st0.pending[0].id });
  st0 = (await httpReq('GET', `/api/state?p=${slug}`)).body;
  assert(st0.battle.hp.human === hpBeforeSkip - D.skip && st0.battle.last.cause === 'skip', 'skipping costs HP');
  r = await tool('skillme_correction', { summary: 'off-by-one in the loop', files: ['src/db.js'], severity: 1 });
  st0 = (await httpReq('GET', `/api/state?p=${slug}`)).body;
  assert(st0.battle.last.cause === 'correction' && st0.battle.last.target === 'ai' && st0.battle.last.damage === D.correction(1), 'catching Claude in chat hits it');
  assert(/You \d+ HP vs Claude \d+ HP/.test(r.text), r.text);
  // knock Claude out: right answers until 0 HP
  const xpBeforeKo = st0.scores.xp;
  let ko = null;
  for (let i = 0; i < 12 && !ko; i++) {
    const t = await tool('skillme_quiz', { quizzes: [quiz({ question: `KO round ${i}: what does login() return?` })] });
    assert(!t.isError, t.text);
    const pq2 = (await httpReq('GET', `/api/state?p=${slug}`)).body.pending.find((q) => q.question.startsWith(`KO round ${i}:`));
    const a = await httpReq('POST', '/api/answer', { p: slug, quizId: pq2.id, choice: answerKey(pq2.id) });
    if (a.body.hit.ko) ko = a.body;
  }
  assert(ko && ko.hit.ko === 'human' && ko.battle.hp.ai === 0 && ko.battle.over === 'human' && ko.hit.xp === 50, 'Claude knocked out at 0 HP');
  st0 = (await httpReq('GET', `/api/state?p=${slug}`)).body;
  assert(st0.battle.wins >= 1 && st0.scores.xp >= xpBeforeKo + 50, 'victory: +50 XP and a win on the record');
  s = await httpReq('POST', '/api/battle', { p: slug });
  assert(s.body.battle.n === battleNo + 1 && s.body.battle.hp.ai === 100 && !s.body.battle.over, 'fight again: full HP, next battle');
  ok('battle: 100 HP each; right answers hit Claude, wrong/skips hit you, catching Claude hits hard; KO at 0 HP gives +50 XP; rematch resets HP');

  // ---- statusline
  const sl = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'statusline.js')], { env, input: JSON.stringify({ workspace: { current_dir: PROJ } }), encoding: 'utf8' });
  assert(/You \d+ HP/.test(sl.stdout) && /Claude \d+ HP/.test(sl.stdout) && !/\p{Extended_Pictographic}/u.test(sl.stdout), sl.stdout);
  ok('statusline renders the duel: ' + sl.stdout.replace(/\x1b\[\d+m/g, ''));

  srv.stdin.end();
  orSrv.close();
  await wait(200);
  console.log(`\nAll ${passed} checks passed.`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e.stack || e);
  console.error('server stderr:\n' + stderr);
  srv.kill();
  orSrv.close();
  process.exit(1);
});

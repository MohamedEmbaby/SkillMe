'use strict';
/**
 * SkillMe tutor: a SEPARATE AI that answers the user's follow-up questions and judges challenges
 * straight from the Arena, so the coding session is never interrupted or waited on.
 *
 * It calls OpenRouter's chat completions API directly (Node's built-in fetch, no CLI, no SDK).
 * Default model: "openrouter/auto", OpenRouter's Auto Router, which picks a model for each request.
 * The API key comes from the OPENROUTER_API_KEY environment variable, or from ~/.skillme/secrets.json
 * (saved from the Arena's tutor settings). The key is never sent to the Arena page or to the coding AI.
 */
const fs = require('fs');
const path = require('path');
const core = require('./core');

const DEFAULT_MODEL = 'openrouter/auto';
const TIMEOUT_MS = 120000;
const MAX_PARALLEL = 2;
const KEY_CHECK_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- key + settings
const secretsFile = () => path.join(core.HOME, 'secrets.json');

function readSecrets() {
  try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) || {}; } catch { return {}; }
}

function getKey() {
  const env = String(process.env.OPENROUTER_API_KEY || '').trim();
  return env || String(readSecrets().openrouterKey || '').trim();
}

function keySource() {
  if (String(process.env.OPENROUTER_API_KEY || '').trim()) return 'env';
  return readSecrets().openrouterKey ? 'saved' : null;
}

/** Save (or with '' remove) the key typed into the Arena. Readable by the current user only. */
function saveKey(key) {
  const k = String(key || '').trim();
  if (k && !/^sk-or-[\w-]{8,200}$/.test(k)) return { ok: false, error: 'That does not look like an OpenRouter key (they start with sk-or-).' };
  const next = { ...readSecrets() };
  if (k) next.openrouterKey = k; else delete next.openrouterKey;
  fs.mkdirSync(core.HOME, { recursive: true });
  fs.writeFileSync(secretsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  resetChecks();
  return { ok: true };
}

// OpenRouter ids are "vendor/model" (e.g. openrouter/auto, anthropic/claude-sonnet-5.5). Anything else,
// like a model name left over from the old CLI tutor, falls back to the Auto Router.
const MODEL_ID = /^[\w.-]{1,40}\/[\w.:\/-]{1,80}$/;

function model() {
  const m = String(core.getConfig().tutorModel || '').trim();
  return MODEL_ID.test(m) ? m : DEFAULT_MODEL;
}

function setModel(m) {
  const v = String(m || '').trim() || DEFAULT_MODEL;
  if (!MODEL_ID.test(v)) return { ok: false, error: 'Use an OpenRouter model id like openrouter/auto or anthropic/claude-sonnet-5.5.' };
  core.setConfig({ tutorModel: v });
  return { ok: true };
}

// Only an environment variable can change where the key is sent (tests use a local fake server).
const baseUrl = () => (process.env.SKILLME_TUTOR_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

// ---------------------------------------------------------------- status
// The free GET /key endpoint tells us whether the key works before any paid request.
let check = { key: '', ok: null, at: 0, busy: false };
let block = null; // { state, until } after a failed request: bad key, no credits, rate limit

function resetChecks() { check = { key: '', ok: null, at: 0, busy: false }; block = null; }

function refreshKeyCheck(key) {
  if (check.busy || (check.key === key && Date.now() - check.at < KEY_CHECK_MS)) return;
  check = { key, ok: check.key === key ? check.ok : null, at: Date.now(), busy: true };
  fetch(`${baseUrl()}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
    .then((r) => { if (check.key === key) check.ok = r.status === 401 || r.status === 403 ? false : r.ok ? true : check.ok; })
    .catch(() => {})
    .finally(() => { if (check.key === key) { check.busy = false; check.at = Date.now(); } });
}

/** For the Arena: can the tutor take requests right now? Never includes the key. */
function status() {
  const base = { model: model(), keySource: keySource() };
  if (core.getConfig().tutor === 'off') return { ...base, available: false, state: 'off' };
  const key = getKey();
  if (!key) return { ...base, available: false, state: 'no_key' };
  refreshKeyCheck(key);
  if (check.key === key && check.ok === false) return { ...base, available: false, state: 'bad_key' };
  if (block && Date.now() < block.until) return { ...base, available: false, state: block.state };
  return { ...base, available: true, state: 'ready' };
}

// ---------------------------------------------------------------- requests
const SYSTEM = 'You are the SkillMe tutor. A developer is learning a codebase while an AI coding assistant builds it, by answering short quizzes about the code. ' +
  'You only see the excerpts you are given; never invent code that is not there. Always reply with ONLY the JSON object you are asked for.';

async function runNow(prompt) {
  const key = getKey();
  if (!key) return { ok: false, reason: 'no_key', detail: 'no OpenRouter key' };
  let res;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'SkillMe' },
      body: JSON.stringify({
        model: model(),
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
        max_tokens: 4000, // a cap, not a target: reasoning models need room before they answer
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: e && e.name === 'TimeoutError' ? 'timeout' : 'network', detail: String((e && e.message) || e) };
  }
  let j = null;
  try { j = await res.json(); } catch {}
  const msg = (j && j.error && (j.error.message || j.error.code)) || `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) {
    if (check.key === key) check.ok = false; else check = { key, ok: false, at: Date.now(), busy: false };
    return { ok: false, reason: 'bad_key', detail: String(msg) };
  }
  if (res.status === 402) { block = { state: 'no_credits', until: Date.now() + 2 * 60000 }; return { ok: false, reason: 'no_credits', detail: String(msg) }; }
  if (res.status === 429) { block = { state: 'rate_limited', until: Date.now() + 20000 }; return { ok: false, reason: 'rate_limited', detail: String(msg) }; }
  if (!res.ok || !j) return { ok: false, reason: 'error', detail: String(msg).slice(0, 200) };
  const choice = j.choices && j.choices[0];
  let text = choice && choice.message && choice.message.content;
  if (Array.isArray(text)) text = text.map((p) => (p && p.text) || '').join('');
  text = String(text || '').trim();
  if (!text) return { ok: false, reason: 'error', detail: choice && choice.finish_reason === 'length' ? 'the reply was cut off' : 'empty reply' };
  block = null;
  if (check.key === key) check.ok = true;
  return { ok: true, text, model: String(j.model || model()) };
}

let running = 0;
const queue = [];

/** Run a tutor prompt, at most MAX_PARALLEL at a time. */
function run(prompt) {
  return new Promise((resolve) => {
    queue.push({ prompt, resolve });
    pump();
  });
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    running++;
    runNow(job.prompt).then((r) => { running--; job.resolve(r); pump(); });
  }
}

/** Failures that clear up on their own or once the user fixes the key: keep waiting, don't count a try. */
const isBlocking = (reason) => ['no_key', 'bad_key', 'no_credits', 'rate_limited'].includes(reason);

/** Pull the first JSON object out of a model reply (tolerates ```json fences and chatter). */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// ---------------------------------------------------------------- code excerpts
// The tutor has no file access of its own: we send the files the quiz is about, and nothing else.
const SECRET_FILE = /(^|[\\/])(\.env[^\\/]*|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|secrets?(\.[^\\/]*)?|credentials?(\.[^\\/]*)?|[^\\/]*\.(pem|key|p12|pfx|keystore|jks))$/i;
const MAX_FILE_LINES = 260;
const MAX_TOTAL_CHARS = 60000;

function excerpts(root, files) {
  const out = [];
  let total = 0;
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
  for (const ref of (files || []).slice(0, 4)) {
    const m = /^(.*?)(?::(\d+))?$/.exec(String(ref));
    const rel = m[1];
    const line = m[2] ? Number(m[2]) : 0;
    if (!rel || SECRET_FILE.test(rel)) continue;
    let abs;
    try { abs = fs.realpathSync(path.resolve(root, rel)); } catch { continue; }
    const inside = path.relative(realRoot, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue; // never outside the project
    let text;
    try {
      if (fs.statSync(abs).size > 400000) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue; // binary
    const lines = text.split(/\r?\n/);
    let from = 0;
    if (lines.length > MAX_FILE_LINES) from = Math.max(0, Math.min(lines.length - MAX_FILE_LINES, (line || 1) - Math.floor(MAX_FILE_LINES / 2)));
    const slice = lines.slice(from, from + MAX_FILE_LINES);
    let block = `--- ${rel.replace(/\\/g, '/')} (lines ${from + 1}-${from + slice.length} of ${lines.length}) ---\n` +
      slice.map((l, i) => `${from + i + 1}| ${l}`).join('\n');
    if (total + block.length > MAX_TOTAL_CHARS) block = block.slice(0, Math.max(0, MAX_TOTAL_CHARS - total)) + '\n[...truncated]';
    total += block.length;
    out.push(block);
    if (total >= MAX_TOTAL_CHARS) break;
  }
  return out.join('\n\n');
}

// ---------------------------------------------------------------- prompts
const L = (i) => String.fromCharCode(65 + i);

function quizBlock(q) {
  return [
    `Context given to the developer: ${q.context || '(none)'}`,
    `Question: ${q.question}`,
    q.code ? `Code shown:\n${q.code}` : '',
    `Options:\n${q.options.map((o, i) => `  ${L(i)}) ${o}`).join('\n')}`,
    `Answer key: ${L(q.answer)}) ${q.options[q.answer]}`,
    q.choice !== null && q.choice !== undefined ? `Developer chose: ${L(q.choice)}) ${q.options[q.choice]} (${q.choice === q.answer ? 'correct' : 'wrong'})` : '',
    `Explanation shown: ${q.explanation}`,
    q.lesson ? `Lesson shown: ${q.lesson}` : '',
  ].filter(Boolean).join('\n');
}

function codeBlock(root, q) {
  const code = excerpts(root, q.files);
  return code ? `\nProject files the quiz is about:\n${code}\n` : '\n(No project files are attached to this quiz.)\n';
}

function askPrompt(root, q, question) {
  const history = (q.thread || []).filter((m) => m.role !== 'system').slice(-8)
    .map((m) => `${m.role === 'user' ? 'Developer' : 'Tutor'}: ${m.text}`).join('\n');
  return `The developer answered this quiz and wants to understand it better. Teach clearly, concretely and kindly.

${quizBlock(q)}
${codeBlock(root, q)}${history ? `\nConversation so far:\n${history}\n` : ''}
Developer's request: ${question || 'Explain this more deeply, with a small example from this project.'}

Keep the answer under ~170 words; a short code snippet from the files above is welcome. Reply with ONLY a JSON object: {"answer": "<your answer>"}`;
}

function judgePrompt(root, q) {
  const picked = q.challenge && Number.isInteger(q.challenge.proposed) ? q.challenge.proposed : q.choice;
  return `You are an impartial judge. The coding assistant wrote this quiz; the developer CHALLENGED its answer key.

${quizBlock(q)}
${codeBlock(root, q)}
Developer's pick for the challenge: ${picked !== null && picked !== undefined ? `${L(picked)}) ${q.options[picked]}` : '(none)'}
Developer's argument: "${(q.challenge && q.challenge.note) || '(no argument given)'}"

Check the code above and the facts. Rules:
- "human_right" if the developer is right, OR the question/answer key is ambiguous, misleading, or relies on an unstated assumption the developer exposed.
- "ai_right" only if the keyed answer is clearly correct and the argument doesn't change that.
- "fix": only if the challenge exposes a real problem in the CODE itself (a bug, wrong behaviour, misleading comment or name). Describe concretely what the coding session should change (file:line). Use null when only the quiz was flawed or the code is fine.
- "explanation": under ~110 words, addressed to the developer ("you"); be fair and teach the underlying point either way.

Reply with ONLY a JSON object: {"verdict": "human_right" | "ai_right", "explanation": "...", "fix": null | "..."}`;
}

module.exports = {
  DEFAULT_MODEL, status, run, isBlocking, extractJson, askPrompt, judgePrompt, excerpts,
  saveKey, setModel, keySource, resetChecks,
};

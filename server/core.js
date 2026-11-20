'use strict';
/**
 * SkillMe core: state store + scoring engine.
 * Shared by the MCP server (server/index.js), the Claude Code hooks (scripts/hook.js)
 * and the statusline (scripts/statusline.js). Zero dependencies.
 *
 * State lives in ~/.skillme/projects/<name>-<hash>/state.json (override with SKILLME_HOME), or, when the
 * "save in project" toggle is on, in <project>/.claude/skillme/state.json (with a pointer left in ~/.skillme).
 * Every mutation goes through updateState(): lock -> read -> mutate -> atomic write -> unlock,
 * so several processes (hooks, MCP servers of parallel sessions, the arena) can share it.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const VERSION = '0.4.0';
const TUTOR_STALE_MS = 4 * 60 * 1000; // a tutor job older than this is treated as lost
const HOME = process.env.SKILLME_HOME || path.join(os.homedir(), '.skillme');
const PROJECTS_DIR = path.join(HOME, 'projects');

const DEFAULT_CONFIG = {
  mode: 'arena',       // arena | off: quizzes are only ever answered in the Arena, never in the coding session
  quizEveryEdits: 2,   // nudge the AI for quizzes after N file edits...
  quizEveryLines: 25,  // ...or after N changed lines, whichever comes first
  minSecondsBetweenNudges: 20,
  maxPending: 6,       // unanswered quizzes kept in the queue (oldest expire)
  port: 4747,
  autoOpenArena: true, // the Arena is the only place to answer, so open it when quizzes arrive and nobody is watching
  stopHookQuiz: true,  // ask for a final quiz before the AI ends a turn with unquizzed changes
  saveInProject: false, // default for NEW projects: keep quiz data in <project>/.claude/skillme instead of ~/.skillme
  openIn: 'app',       // app | browser: where the Arena opens (the app window needs: node scripts/cli.js app install)
  tutor: 'auto',       // auto | off — a separate AI (via OpenRouter) answers Arena questions and judges challenges
  tutorModel: 'openrouter/auto', // any OpenRouter model id; the Auto Router picks a model per request
};

const LEVELS = [
  [0, 'Spectator'], [50, 'Rubber Duck'], [150, 'Code Reader'], [300, 'Pair Programmer'],
  [500, 'Code Reviewer'], [800, 'Co-Pilot'], [1200, 'Tech Lead'], [1800, 'Architect'],
  [2500, 'Codebase Oracle'],
];

const BADGES = {
  first_blood: { name: 'First Blood', desc: 'First correct answer' },
  on_fire: { name: 'On Fire', desc: '5 correct in a row' },
  unstoppable: { name: 'Unstoppable', desc: '10 correct in a row' },
  gotcha: { name: 'Gotcha!', desc: 'Caught the AI making a mistake' },
  bug_hunter: { name: 'Bug Hunter', desc: 'Caught the AI 3 times' },
  overtake: { name: 'Overtake', desc: 'Your understanding passed the AI\'s knowledge' },
  scholar: { name: 'Scholar', desc: 'Asked for 3 deep-dive explanations' },
  speedster: { name: 'Speedster', desc: '5 correct answers in under 20s' },
  polymath: { name: 'Polymath', desc: 'Correct answers on 5 different concepts' },
  diamond: { name: 'Diamond Brain', desc: '5 correct answers on hard (level 3) quizzes' },
};

// ---------------------------------------------------------------- the battle
// You and Claude both start at 100 HP. A right answer hits Claude; a wrong answer, a skip or an expired quiz
// lets Claude hit you. Winning a challenge or catching Claude's mistake in chat hits harder. 0 HP = knocked out.
const MAX_HP = 100;
const VICTORY_XP = 50;
const DAMAGE = {
  right: (difficulty) => 8 + 4 * difficulty,       // 12 / 16 / 20
  crit: 1.5,                                        // a right answer within 20 seconds is a critical hit
  streak: (streak) => 2 * Math.min(Math.max(streak - 1, 0), 5), // +2 per answer in a row, up to +10
  wrong: (difficulty) => 10 + 5 * difficulty,       // 15 / 20 / 25
  skip: 10,
  expired: 8,
  challengeWon: 25,
  challengeLost: 10,
  correction: (severity) => 10 + 10 * severity,     // 20 / 30 / 40
};

const IGNORED_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor',
  '__pycache__', '.venv', 'venv', 'target', 'coverage', '.idea', '.vscode', '.skillme', 'bin', 'obj', '.gradle',
  // Unity / Unreal / Godot generated folders
  'Library', 'Temp', 'Logs', 'UserSettings', 'MemoryCaptures', 'Builds', 'Intermediate', 'Saved', 'DerivedDataCache', '.godot']);
const CODE_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'scala', 'dart', 'lua', 'sh', 'ps1', 'sql',
  'html', 'css', 'scss', 'sass', 'less', 'json', 'yaml', 'yml', 'toml', 'md', 'graphql', 'prisma', 'proto',
  'tf', 'ex', 'exs', 'erl', 'clj', 'hs', 'ml', 'r', 'jl', 'zig', 'nim', 'astro', 'ipynb', 'gradle', 'xml']);

// ---------------------------------------------------------------- helpers
const now = () => Date.now();
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const uid = (p) => p + '_' + crypto.randomBytes(4).toString('hex');
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const toPosix = (p) => p.split(path.sep).join('/');

function isCodeFile(rel) {
  const parts = rel.split('/');
  if (parts.some((s) => IGNORED_DIRS.has(s))) return false;
  const base = parts[parts.length - 1];
  if (/\.(min\.js|lock)$/i.test(base) || /^(package-lock|yarn\.lock|pnpm-lock)/i.test(base)) return false;
  const ext = (base.includes('.') ? base.split('.').pop() : '').toLowerCase();
  return CODE_EXT.has(ext) || /^(Dockerfile|Makefile|Procfile)$/i.test(base);
}

/** Find the project root: nearest ancestor containing .git, else the dir itself. */
function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  try { if (fs.statSync(dir).isFile()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
  let cur = dir;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dir;
}

function defaultRoot() {
  return findRoot(process.env.SKILLME_PROJECT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function projectSlug(root) {
  const norm = path.resolve(root).toLowerCase().replace(/\\/g, '/');
  const hash = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8);
  const name = path.basename(root).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40) || 'project';
  return `${name}-${hash}`;
}

const projectDir = (slug) => path.join(PROJECTS_DIR, slug);
const homeStatePath = (slug) => path.join(projectDir(slug), 'state.json');
const localStatePath = (root) => path.join(root, '.claude', 'skillme', 'state.json');
const whereFile = (slug) => path.join(projectDir(slug), 'where.json'); // { root } of a project saved in its own folder

/** Where a project's state lives: its own .claude/skillme folder (toggle on) or ~/.skillme (default). */
function stateFileFor(root) {
  const local = localStatePath(root);
  if (fs.existsSync(local)) return { file: local, inProject: true };
  const home = homeStatePath(projectSlug(root));
  if (!fs.existsSync(home) && getConfig().saveInProject) return { file: local, inProject: true }; // new project
  return { file: home, inProject: false };
}

/** Relative posix path of `file` inside `root`, or null if outside / ignored. */
function relPath(root, file) {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const posix = toPosix(rel);
  return isCodeFile(posix) ? posix : null;
}

/** Normalise a file reference coming from the AI (absolute, relative, or "file:line"). */
function normalizeRef(root, ref) {
  if (!ref || typeof ref !== 'string') return null;
  const clean = ref.replace(/:(\d+)(-\d+)?$/, '').trim();
  const abs = path.isAbsolute(clean) ? clean : path.join(root, clean);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) return toPosix(clean);
  return toPosix(rel);
}

/** Count code files in the project (cached in state for 10 min). */
function countCodeFiles(root, limit = 5000) {
  let count = 0;
  const stack = [root];
  while (stack.length && count < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(path.join(dir, e.name));
      } else if (e.isFile() && isCodeFile(toPosix(path.relative(root, path.join(dir, e.name))))) {
        if (++count >= limit) break;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------- config
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  for (let i = 0; i < 20; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i === 19) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      sleepSync(15);
    }
  }
}

function getConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(path.join(HOME, 'config.json'), {}) };
}

function setConfig(patch) {
  // Only overrides are stored, so improved defaults reach users who never changed a setting.
  const file = path.join(HOME, 'config.json');
  writeJsonAtomic(file, { ...readJson(file, {}), ...patch });
  return getConfig();
}

// ---------------------------------------------------------------- state
function emptyState(root) {
  return {
    version: 1,
    project: { name: path.basename(root), root, slug: projectSlug(root) },
    createdAt: now(),
    updatedAt: now(),
    paused: false,
    totalFiles: null,
    totalFilesAt: 0,
    units: {},           // per-file knowledge: { w, h, a, reads, writes, lines, quizzes, correct, touchedAt }
    ai: { trust: 1, corrections: 0, wins: 0 },
    human: {
      xp: 0, streak: 0, bestStreak: 0, answered: 0, correct: 0, quick: 0, hardCorrect: 0,
      explains: 0, gotchas: 0, conceptsCorrect: [], badges: [],
    },
    quizzes: [],         // newest last
    events: [],          // fix requests for the coding session
    counters: { editsSinceQuiz: 0, linesSinceQuiz: 0, filesSinceQuiz: [], lastNudgeAt: 0, lastQuizAt: 0 },
  };
}

function loadState(root) {
  const s = readJson(stateFileFor(root).file, null);
  return s && s.version === 1 ? s : emptyState(root);
}

function loadStateBySlug(slug) {
  const home = readJson(homeStatePath(slug), null);
  if (home) return home;
  const where = readJson(whereFile(slug), null);
  return where && where.root ? readJson(localStatePath(where.root), null) : null;
}

/** The "save in project" toggle: move this project's quiz data between ~/.skillme and <project>/.claude/skillme. */
function setSaveInProject(root, on) {
  const slug = projectSlug(root);
  return withLock(slug, () => {
    const cur = stateFileFor(root);
    const exists = fs.existsSync(cur.file);
    if (cur.inProject === !!on && exists) return { ok: true, inProject: cur.inProject, file: cur.file };
    const state = loadState(root);
    state.project.root = root;
    const target = on ? localStatePath(root) : homeStatePath(slug);
    writeJsonAtomic(target, state);
    if (exists && cur.file !== target) fs.unlinkSync(cur.file);
    if (on) writeJsonAtomic(whereFile(slug), { root });
    else {
      try { fs.unlinkSync(whereFile(slug)); } catch {}
      try { fs.rmdirSync(path.dirname(localStatePath(root))); } catch {} // only if empty
    }
    return { ok: true, inProject: !!on, file: target };
  });
}

function withLock(slug, fn) {
  const dir = projectDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const start = now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (now() - fs.statSync(lock).mtimeMs > 5000) { fs.rmdirSync(lock); continue; } } catch {}
      if (now() - start > 4000) { try { fs.rmdirSync(lock); } catch {} continue; }
      sleepSync(10);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

/** Read-modify-write the project state. `fn(state)` may return a value which is passed through. */
function updateState(root, fn) {
  const slug = projectSlug(root);
  return withLock(slug, () => {
    const state = loadState(root);
    state.project.root = root;
    const result = fn(state);
    state.updatedAt = now();
    trim(state);
    const where = stateFileFor(root);
    writeJsonAtomic(where.file, state);
    if (where.inProject) {
      const w = readJson(whereFile(slug), null);
      if (!w || w.root !== root) writeJsonAtomic(whereFile(slug), { root });
    }
    return result;
  });
}

function trim(s) {
  delete s.feed;   // older versions kept an activity feed
  delete s.brief;  // ...and a pinned brief
  if (s.events.length > 100) s.events = s.events.slice(-100);
  if (s.quizzes.length > 150) {
    const keep = s.quizzes.filter((q) => q.status === 'pending');
    const done = s.quizzes.filter((q) => q.status !== 'pending').slice(-(150 - keep.length));
    s.quizzes = [...done, ...keep].sort((a, b) => a.ts - b.ts);
  }
}

function ensureUnit(s, rel) {
  if (!s.units[rel]) {
    s.units[rel] = { w: 2, h: 0, a: 0, reads: 0, writes: 0, lines: 0, quizzes: 0, correct: 0, touchedAt: now() };
  }
  return s.units[rel];
}

function refreshTotalFiles(s, root) {
  if (!s.totalFiles || now() - (s.totalFilesAt || 0) > 10 * 60 * 1000) {
    s.totalFiles = countCodeFiles(root);
    s.totalFilesAt = now();
  }
}

// ---------------------------------------------------------------- scoring
/**
 * Human %  = how well you understand the code the AI touched (weighted by lines it wrote).
 * AI %     = the AI's knowledge of those same files, multiplied by its "trust" (drops when you catch it).
 * Map %    = how much of the whole codebase the AI has explored.
 */
function battleOf(s) {
  if (!s.battle) s.battle = { n: 1, hp: { human: MAX_HP, ai: MAX_HP }, wins: 0, losses: 0, over: null, last: null };
  return s.battle;
}

/** Start the next battle: both back to full HP. The win/loss record stays. */
function newBattle(s) {
  const b = battleOf(s);
  b.n++;
  b.hp = { human: MAX_HP, ai: MAX_HP };
  b.over = null;
  b.last = null;
  return { ok: true, battle: publicBattle(s) };
}

/**
 * Land a blow. target: 'ai' (you hit Claude) or 'human' (Claude hit you). The first blow after a
 * knockout opens the next battle. Returns the hit, so the Arena can animate it.
 */
function hit(s, target, amount, cause, extra = {}) {
  let b = battleOf(s);
  let started = false;
  if (b.over) { newBattle(s); b = battleOf(s); started = true; }
  const damage = Math.max(1, Math.round(amount));
  b.hp[target] = Math.max(0, b.hp[target] - damage);
  const out = { id: uid('h'), ts: now(), target, damage, cause, crit: !!extra.crit, hp: { ...b.hp }, battle: b.n, started };
  if (b.hp[target] === 0) {
    b.over = target === 'ai' ? 'human' : 'ai';
    if (b.over === 'human') { b.wins++; s.human.xp += VICTORY_XP; out.xp = VICTORY_XP; } else b.losses++;
    out.ko = b.over; // who won
  }
  b.last = out;
  return out;
}

function publicBattle(s) {
  const b = battleOf(s);
  return { n: b.n, hp: { ...b.hp }, max: MAX_HP, wins: b.wins, losses: b.losses, over: b.over, last: b.last };
}

function scores(s) {
  let W = 0, H = 0, A = 0;
  for (const u of Object.values(s.units)) { W += u.w; H += u.h * u.w; A += u.a * u.w; }
  const human = W ? Math.round((H / W) * 100) : 0;
  const ai = W ? Math.round((A / W) * s.ai.trust * 100) : 0;
  const explored = Object.values(s.units).filter((u) => u.reads + u.writes > 0).length;
  const total = Math.max(s.totalFiles || 0, explored);
  const level = levelFor(s.human.xp);
  return {
    human, ai, gap: human - ai,
    leader: human > ai ? 'human' : human < ai ? 'ai' : 'tie',
    trust: Math.round(s.ai.trust * 100),
    explored, totalFiles: total, mapPct: total ? Math.round((explored / total) * 100) : 0,
    xp: s.human.xp, level: level.index + 1, title: level.title, nextLevelXp: level.next,
    levelProgress: level.progress,
    streak: s.human.streak, bestStreak: s.human.bestStreak,
    answered: s.human.answered, correct: s.human.correct,
    accuracy: s.human.answered ? Math.round((s.human.correct / s.human.answered) * 100) : null,
    pending: s.quizzes.filter((q) => q.status === 'pending').length,
    badges: s.human.badges.map((id) => ({ id, ...BADGES[id] })),
    aiCorrections: s.ai.corrections,
    hp: s.battle ? { ...s.battle.hp } : { human: MAX_HP, ai: MAX_HP },
    battle: s.battle ? s.battle.n : 1, wins: s.battle ? s.battle.wins : 0, losses: s.battle ? s.battle.losses : 0,
  };
}

function levelFor(xp) {
  let index = 0;
  for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i][0]) index = i;
  const cur = LEVELS[index][0];
  const next = LEVELS[index + 1] ? LEVELS[index + 1][0] : null;
  return { index, title: LEVELS[index][1], next, progress: next ? (xp - cur) / (next - cur) : 1 };
}

function bar(pct, width = 10) {
  const n = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

function scoreLine(s) {
  const sc = scores(s);
  const lead = sc.leader === 'human' ? "you're ahead!" : sc.leader === 'ai' ? `AI leads by ${-sc.gap}%` : 'dead even';
  return `Battle ${sc.battle}: You ${sc.hp.human} HP vs Claude ${sc.hp.ai} HP (record ${sc.wins}-${sc.losses}) · ` +
    `understanding ${sc.human}% vs AI knowledge ${sc.ai}% (${lead}) · Lv${sc.level} ${sc.title} · ${sc.xp} XP · streak ${sc.streak}` +
    (sc.pending ? ` · ${sc.pending} quiz waiting` : '');
}

function suggestedDifficulty(s) {
  const recent = s.quizzes.filter((q) => q.status === 'answered').slice(-5);
  if (recent.length < 2) return 1;
  const acc = recent.filter((q) => q.correct).length / recent.length;
  return acc >= 0.8 ? 3 : acc >= 0.5 ? 2 : 1;
}

function weakConcepts(s) {
  const tally = {};
  for (const q of s.quizzes.filter((x) => x.status === 'answered').slice(-30)) {
    const t = (tally[q.concept] = tally[q.concept] || { right: 0, wrong: 0 });
    q.correct ? t.right++ : t.wrong++;
  }
  return Object.entries(tally).filter(([, t]) => t.wrong > t.right).map(([c]) => c).slice(0, 5);
}

function award(s, id, out) {
  if (!s.human.badges.includes(id)) {
    s.human.badges.push(id);
    if (out) out.push({ id, ...BADGES[id] });
  }
}

function checkOvertake(s, out) {
  const sc = scores(s);
  if (Object.keys(s.units).length >= 3 && sc.human >= sc.ai && sc.human > 0) award(s, 'overtake', out);
}

// ---------------------------------------------------------------- AI activity (hooks / skillme_track)
/** Record that the AI read or wrote a file. Returns the unit or null if not tracked. */
function trackActivity(s, root, file, action, lines = 0, opts = {}) {
  const rel = relPath(root, file);
  if (!rel) return null;
  const u = ensureUnit(s, rel);
  u.touchedAt = now();
  if (action === 'read') {
    u.reads++;
    u.a = Math.max(u.a, opts.partial ? 0.45 : 0.7);
  } else if (action === 'write') {
    const n = Math.max(1, Math.round(lines));
    u.writes++;
    u.lines += n;
    u.w = Math.min(2 + u.lines, 220);
    u.a = clamp01(Math.max(u.a, 0.8) + 0.05);
    // The code changed under you: your understanding of this file decays.
    u.h = u.h * Math.max(0.5, 1 - n / (n + 40));
    // A clean edit slowly rebuilds the AI's trust.
    s.ai.trust = Math.min(1, s.ai.trust + 0.01);
    s.counters.editsSinceQuiz++;
    s.counters.linesSinceQuiz += n;
    if (!s.counters.filesSinceQuiz.includes(rel)) s.counters.filesSinceQuiz.push(rel);
    if (s.counters.filesSinceQuiz.length > 12) s.counters.filesSinceQuiz.shift();
  }
  return u;
}

// ---------------------------------------------------------------- quizzes
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function validateQuiz(q) {
  const errors = [];
  if (!q || typeof q.question !== 'string' || !q.question.trim()) errors.push('question is required');
  else if (q.question.length > 240) errors.push(`question is ${q.question.length} chars; keep it under 240 (quizzes must be short)`);
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) errors.push('options must have 2-4 entries');
  else if (q.options.some((o) => typeof o !== 'string' || !o.trim() || o.length > 140)) errors.push('each option must be a non-empty string under 140 chars');
  if (!Number.isInteger(q.answer) || !Array.isArray(q.options) || q.answer < 0 || q.answer >= q.options.length) errors.push('answer must be the 0-based index of the correct option');
  if (typeof q.explanation !== 'string' || !q.explanation.trim()) errors.push('explanation is required (it teaches the user when they miss)');
  if (typeof q.context !== 'string' || q.context.trim().length < 15) errors.push('context is required: 1-3 sentences telling the user what the thing you ask about IS and what it does in this project (e.g. "Gates are the obstacles: two pillars with a gap...")');
  else if (q.context.length > 420) errors.push(`context is ${q.context.length} chars; keep it under 420`);
  const deep = q.deep_dive || q.deepDive;
  if (deep && String(deep).length > 1600) errors.push('deep_dive must be under 1600 chars');
  if (q.code && q.code.split('\n').length > 16) errors.push('code snippet must be 16 lines or fewer');
  return errors;
}

function pushQuiz(s, root, input) {
  const errors = validateQuiz(input);
  if (errors.length) return { ok: false, errors };
  const cfg = getConfig();
  // Expire the oldest pending quizzes so the queue stays short and fresh (replayed ones are kept).
  const pending = s.quizzes.filter((q) => q.status === 'pending' && !q.replay);
  const expired = [];
  while (pending.length >= cfg.maxPending) {
    const old = pending.shift();
    old.status = 'expired';
    expired.push(old.id);
    hit(s, 'human', DAMAGE.expired, 'expired');
  }

  const order = shuffle(input.options.map((text, i) => ({ text, i })));
  const files = (input.files || []).map((f) => normalizeRef(root, f)).filter(Boolean).slice(0, 5);
  const difficulty = [1, 2, 3].includes(input.difficulty) ? input.difficulty : 2;
  const quiz = {
    id: uid('q'),
    n: (s.quizzes.length ? Math.max(...s.quizzes.map((q) => q.n || 0)) : 0) + 1,
    ts: now(),
    context: input.context.trim(),
    question: input.question.trim(),
    code: input.code ? String(input.code).replace(/\s+$/, '') : '',
    language: input.language || '',
    options: order.map((o) => o.text),
    answer: order.findIndex((o) => o.i === input.answer),
    explanation: input.explanation.trim(),
    lesson: (input.lesson || '').trim(),
    deepDive: String(input.deep_dive || input.deepDive || '').trim(),
    concept: (input.concept || 'general').trim().slice(0, 60),
    files,
    difficulty,
    status: 'pending',
    shownAt: null,
    choice: null,
    correct: null,
    challenge: null,
    explainRequested: false,
    thread: [],          // follow-up Q&A with the tutor: { role: user|tutor|system, text, ts }
    tutorBusy: null,     // 'ask' | 'judge' while the tutor is working
  };
  s.quizzes.push(quiz);
  for (const f of files) {
    const u = s.units[f] || (isCodeFile(f) ? ensureUnit(s, f) : null);
    if (!u) continue;
    u.quizzes++;
    if (u.lines === 0) u.w = Math.max(u.w, 10); // quizzing on existing code makes it count for you
    u.a = clamp01(u.a + 0.03);                  // explaining code sharpens the AI too
  }
  s.counters = { ...s.counters, editsSinceQuiz: 0, linesSinceQuiz: 0, filesSinceQuiz: [], lastQuizAt: now() };
  return { ok: true, quiz, expired };
}

const letter = (i) => String.fromCharCode(65 + i);

function presentQuiz(q) {
  const lines = [`Quiz #${q.n} [${q.concept} · ${'★'.repeat(q.difficulty)}]`, `Context: ${q.context}`, `Q: ${q.question}`];
  if (q.code) lines.push('```' + (q.language || '') + '\n' + q.code + '\n```');
  q.options.forEach((o, i) => lines.push(`  ${letter(i)}) ${o}`));
  return lines.join('\n');
}

function findQuiz(s, id) {
  if (!id) return s.quizzes.filter((q) => q.status === 'pending').slice(-1)[0] || null;
  const n = /^#?\d+$/.test(String(id)) ? Number(String(id).replace('#', '')) : null;
  return s.quizzes.find((q) => q.id === id || (n !== null && q.n === n)) || null;
}

function parseChoice(q, choice) {
  if (Number.isInteger(choice)) return choice;
  const c = String(choice ?? '').trim();
  if (/^[A-Da-d]\)?$/.test(c)) return c.toUpperCase().charCodeAt(0) - 65;
  if (/^\d$/.test(c)) return Number(c) - 1; // "1".."4" = human numbering
  const idx = q.options.findIndex((o) => o.trim().toLowerCase() === c.toLowerCase());
  return idx;
}

/** Grade an answer. Returns a result object (also safe to send to the arena). */
function answerQuiz(s, quizId, rawChoice, source = 'arena') {
  const q = findQuiz(s, quizId);
  if (!q) return { ok: false, error: 'quiz not found' };
  if (q.status === 'answered') return { ok: false, error: 'already answered', quiz: publicQuiz(q, true) };
  const choice = parseChoice(q, rawChoice);
  if (!(choice >= 0 && choice < q.options.length)) return { ok: false, error: 'invalid choice' };

  const before = scores(s);
  const newBadges = [];
  const correct = choice === q.answer;
  const answeredAt = now();
  const ms = q.shownAt ? answeredAt - q.shownAt : null;
  q.status = 'answered';
  q.choice = choice;
  q.correct = correct;
  q.answeredAt = answeredAt;
  q.source = source;

  const h = s.human;
  h.answered++;
  let xp = 0;
  const notes = [];
  if (correct) {
    h.correct++;
    h.streak++;
    h.bestStreak = Math.max(h.bestStreak, h.streak);
    xp += 10 * q.difficulty;
    if (h.streak >= 2) { const b = 2 * Math.min(h.streak, 10); xp += b; notes.push(`streak x${h.streak} (+${b})`); }
    if (ms !== null && ms < 20000) { xp += 5; h.quick++; notes.push('quick (+5)'); }
    if (q.difficulty === 3) h.hardCorrect++;
    if (!h.conceptsCorrect.includes(q.concept)) h.conceptsCorrect.push(q.concept);
    const gain = 0.35 + 0.1 * q.difficulty;
    for (const f of q.files) { const u = s.units[f]; if (u) { u.h = u.h + (1 - u.h) * gain; u.correct++; } }
    award(s, 'first_blood', newBadges);
    if (h.streak >= 5) award(s, 'on_fire', newBadges);
    if (h.streak >= 10) award(s, 'unstoppable', newBadges);
    if (h.quick >= 5) award(s, 'speedster', newBadges);
    if (h.conceptsCorrect.length >= 5) award(s, 'polymath', newBadges);
    if (h.hardCorrect >= 5) award(s, 'diamond', newBadges);
  } else {
    h.streak = 0;
    for (const f of q.files) { const u = s.units[f]; if (u) u.h = u.h * 0.6; }
  }
  h.xp += xp;
  const crit = correct && ms !== null && ms < 20000;
  const blow = correct
    ? hit(s, 'ai', DAMAGE.right(q.difficulty) * (crit ? DAMAGE.crit : 1) + DAMAGE.streak(h.streak), 'answer', { crit })
    : hit(s, 'human', DAMAGE.wrong(q.difficulty), 'answer');
  checkOvertake(s, newBadges);
  const after = scores(s);
  const lvlUp = after.level > before.level ? after.title : null;
  return {
    ok: true, correct, xp, notes, newBadges, levelUp: lvlUp, hit: blow, battle: publicBattle(s),
    answer: q.answer, answerText: q.options[q.answer], choice,
    explanation: q.explanation, lesson: q.lesson, deepDive: q.deepDive || '', concept: q.concept,
    scores: after, delta: { human: after.human - before.human, ai: after.ai - before.ai },
  };
}

/**
 * Restart: every quiz of this project comes back, in its original order, with its options reshuffled.
 * Keeps XP, level, badges and the battle record; resets your understanding, streak, accuracy and both HP bars.
 * The AI's side (what it read and wrote, and the times you caught it) is real history and stays.
 */
function restartQuizzes(s) {
  const all = s.quizzes.slice().sort((a, b) => (a.n || 0) - (b.n || 0));
  if (!all.length) return { ok: false, error: 'There are no quizzes to replay yet.' };
  for (const q of all) {
    const order = shuffle(q.options.map((text, i) => ({ text, i })));
    q.options = order.map((o) => o.text);
    q.answer = order.findIndex((o) => o.i === q.answer);
    Object.assign(q, {
      status: 'pending', replay: true, shownAt: null, choice: null, correct: null, answeredAt: null,
      challenge: null, explainRequested: false, thread: [], tutorBusy: null, tutorWaiting: false, tutorQuestion: '', tutorTries: 0,
    });
  }
  s.quizzes = all;
  Object.assign(s.human, { streak: 0, answered: 0, correct: 0 });
  for (const u of Object.values(s.units)) { u.h = 0; u.correct = 0; }
  s.restarts = (s.restarts || 0) + 1;
  newBattle(s);
  return { ok: true, count: all.length };
}

function markShown(s, quizId) {
  const q = findQuiz(s, quizId);
  if (q && !q.shownAt) q.shownAt = now();
  return !!q;
}

function skipQuiz(s, quizId) {
  const q = findQuiz(s, quizId);
  if (!q || q.status !== 'pending') return false;
  q.status = 'skipped';
  s.human.streak = 0;
  hit(s, 'human', DAMAGE.skip, 'skip');
  return true;
}

function addThread(s, quizId, role, text, meta = {}) {
  const q = findQuiz(s, quizId);
  if (!q) return false;
  q.thread = q.thread || [];
  q.thread.push({ role, text: String(text || '').slice(0, 4000), ts: now(), ...(meta.model ? { model: String(meta.model).slice(0, 100) } : {}) });
  if (q.thread.length > 30) q.thread = q.thread.slice(-30);
  return true;
}

/** "Explain more" (counts toward the Scholar badge). Answered by the deep dive or the tutor, never the coding session. */
function requestExplain(s, quizId) {
  const q = findQuiz(s, quizId);
  if (!q) return false;
  if (!q.explainRequested) {
    q.explainRequested = true;
    s.human.explains++;
    if (s.human.explains >= 3) award(s, 'scholar');
  }
  return true;
}

/** Challenges are judged only by the tutor, in the Arena. */
function challengeQuiz(s, quizId, note, proposed) {
  const q = findQuiz(s, quizId);
  if (!q) return { ok: false, error: 'quiz not found' };
  if (q.status !== 'answered') return { ok: false, error: 'answer the quiz first' };
  if (q.challenge && q.challenge.status === 'open') return { ok: false, error: 'already challenged' };
  if (q.challenge) return { ok: false, error: `already ruled on (${q.challenge.status})` };
  q.challenge = { ts: now(), note: (note || '').slice(0, 500), proposed: Number.isInteger(proposed) ? proposed : q.choice, status: 'open', by: 'tutor' };
  return { ok: true };
}

/** The tutor couldn't judge a challenge after retrying: withdraw it so the user can try again later. */
function cancelChallenge(s, quizId, reason) {
  const q = findQuiz(s, quizId);
  if (!q || !q.challenge || q.challenge.status !== 'open') return false;
  q.challenge = null;
  addThread(s, quizId, 'system', `The tutor couldn't judge your challenge (${reason}). It was withdrawn, so you can challenge again.`);
  return true;
}

/**
 * The tutor rules on a challenge. Honesty matters: if the human is right, the AI loses points.
 * `opts.fix` = a real problem in the code the challenge exposed → queued for the coding session to fix.
 */
function resolveChallenge(s, quizId, verdict, note, opts = {}) {
  const q = findQuiz(s, quizId);
  if (!q || !q.challenge) return { ok: false, error: 'no challenge on that quiz' };
  if (q.challenge.status !== 'open') return { ok: false, error: `already resolved (${q.challenge.status})` };
  q.challenge.status = verdict === 'human_right' ? 'human_right' : 'ai_right';
  q.challenge.resolution = (note || '').slice(0, 900);
  q.challenge.resolvedAt = now();
  if (opts.by) q.challenge.by = opts.by;
  if (opts.model) q.challenge.model = String(opts.model).slice(0, 100);
  const rawFix = typeof opts.fix === 'string' ? opts.fix.trim() : '';
  const fix = q.challenge.status === 'human_right' && rawFix && rawFix.toLowerCase() !== 'null' ? rawFix.slice(0, 900) : null;
  q.challenge.fix = fix;
  if (fix) {
    s.events.push({ id: uid('e'), ts: now(), type: 'fix', quizId: q.id, n: q.n, concept: q.concept, fix, delivered: false });
  }
  const newBadges = [];
  if (q.challenge.status === 'human_right') {
    if (!q.correct) { // regrade: the human was right after all
      q.correct = true;
      s.human.correct++;
      for (const f of q.files) { const u = s.units[f]; if (u) u.h = u.h + (1 - u.h) * 0.5; }
    }
    s.human.xp += 30;
    penalizeAi(s, q.files, 2);
    s.human.gotchas++;
    award(s, 'gotcha', newBadges);
    if (s.human.gotchas >= 3) award(s, 'bug_hunter', newBadges);
    hit(s, 'ai', DAMAGE.challengeWon, 'challenge');
  } else {
    s.ai.wins++;
    hit(s, 'human', DAMAGE.challengeLost, 'challenge');
  }
  checkOvertake(s, newBadges);
  return { ok: true, status: q.challenge.status, newBadges, scores: scores(s) };
}

function penalizeAi(s, files, severity = 2) {
  const factor = { 1: 0.8, 2: 0.6, 3: 0.4 }[severity] || 0.6;
  s.ai.trust = Math.max(0.3, s.ai.trust * (1 - 0.04 * severity));
  s.ai.corrections++;
  for (const f of files || []) { const u = s.units[f]; if (u) u.a = u.a * factor; }
}

/** The user corrected the AI (outside a quiz). */
function recordCorrection(s, root, summary, files, severity) {
  const sev = [1, 2, 3].includes(severity) ? severity : 2;
  const rels = (files || []).map((f) => normalizeRef(root, f)).filter(Boolean);
  for (const r of rels) if (isCodeFile(r)) ensureUnit(s, r);
  const before = scores(s);
  penalizeAi(s, rels, sev);
  const xp = 10 + 10 * sev;
  s.human.xp += xp;
  s.human.gotchas++;
  const newBadges = [];
  award(s, 'gotcha', newBadges);
  if (s.human.gotchas >= 3) award(s, 'bug_hunter', newBadges);
  // Spotting a real mistake shows understanding of that code.
  for (const r of rels) { const u = s.units[r]; if (u) u.h = u.h + (1 - u.h) * 0.3; }
  const blow = hit(s, 'ai', DAMAGE.correction(sev), 'correction');
  checkOvertake(s, newBadges);
  const after = scores(s);
  return { ok: true, xp, newBadges, hit: blow, scores: after, delta: { human: after.human - before.human, ai: after.ai - before.ai } };
}

/** Collect user->AI events not yet delivered; marks them delivered. */
function takeEvents(s) {
  // The coding session only ever gets fix requests; everything else is handled in the Arena.
  const out = s.events.filter((e) => !e.delivered && e.type === 'fix');
  for (const e of out) e.delivered = true;
  return out;
}

function describeEvents(events, s) {
  return events.map((e) => {
    const q = s.quizzes.find((x) => x.id === e.quizId);
    if (e.type === 'fix') return `• FIX REQUEST: the user won a challenge on quiz #${e.n} (${e.concept}) and it exposed a real problem in the code: ${e.fix}\n  Fix this now, before continuing other work, then tell the user in one line what you changed.`;
    return `• ${e.type} on #${e.n}`;
  }).join('\n');
}

function publicQuiz(q, reveal = false) {
  const done = q.status !== 'pending';
  const out = {
    id: q.id, n: q.n, ts: q.ts, context: q.context || '', question: q.question, code: q.code, language: q.language,
    options: q.options, concept: q.concept, files: q.files, difficulty: q.difficulty, status: q.status,
    shownAt: q.shownAt, challenge: q.challenge, explainRequested: q.explainRequested,
    thread: q.thread || [], replay: !!q.replay,
    tutorBusy: q.tutorBusy || null,      // 'ask' | 'judge' while the tutor has work for this quiz
    tutorWaiting: !!q.tutorWaiting,      // queued until the tutor is available (e.g. no OpenRouter key yet)
  };
  if (done || reveal) Object.assign(out, { answer: q.answer, choice: q.choice, correct: q.correct, explanation: q.explanation, lesson: q.lesson, deepDive: q.deepDive || '' });
  return out;
}

/** Snapshot for the arena UI. Pending answers are NOT included (no peeking in devtools!). */
function publicState(s, viewerConnected, tutorStatus) {
  const sc = scores(s);
  let inProject = false;
  try { inProject = stateFileFor(s.project.root).inProject; } catch {}
  return {
    storage: { inProject, path: inProject ? '.claude/skillme/state.json' : '~/.skillme' },
    battle: publicBattle(s),
    app: 'skillme', version: VERSION,
    project: s.project, paused: s.paused, updatedAt: s.updatedAt,
    scores: sc, tutor: tutorStatus || null,
    pending: s.quizzes.filter((q) => q.status === 'pending').map((q) => publicQuiz(q)),
    history: s.quizzes.filter((q) => q.status !== 'pending').slice(-25).reverse().map((q) => publicQuiz(q)),
    weakConcepts: weakConcepts(s),
    allBadges: Object.entries(BADGES).map(([id, b]) => ({ id, ...b, unlocked: s.human.badges.includes(id) })),
    viewerConnected: !!viewerConnected,
  };
}

// ---------------------------------------------------------------- viewer presence (arena open?)
const viewerFile = (slug) => path.join(projectDir(slug), 'viewer.json');
function touchViewer(slug) {
  try { writeJsonAtomic(viewerFile(slug), { lastSeen: now() }); } catch {}
}
function viewerConnected(slug, withinMs = 20000) {
  const v = readJson(viewerFile(slug), null);
  return !!(v && now() - v.lastSeen < withinMs);
}

function listProjects() {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return []; }
  return dirs.map((slug) => {
    const s = loadStateBySlug(slug);
    if (!s) return null;
    return { slug, name: s.project.name, root: s.project.root, updatedAt: s.updatedAt, pending: s.quizzes.filter((q) => q.status === 'pending').length };
  }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

module.exports = {
  VERSION, HOME, BADGES, LEVELS, DEFAULT_CONFIG, TUTOR_STALE_MS,
  findRoot, defaultRoot, projectSlug, relPath, normalizeRef, isCodeFile,
  getConfig, setConfig, loadState, loadStateBySlug, updateState, refreshTotalFiles,
  scores, scoreLine, bar, suggestedDifficulty, weakConcepts,
  trackActivity, pushQuiz, presentQuiz, answerQuiz, markShown, skipQuiz, requestExplain,
  challengeQuiz, cancelChallenge, resolveChallenge, recordCorrection, takeEvents, describeEvents,
  findQuiz, addThread, restartQuizzes, newBattle, publicBattle, MAX_HP, DAMAGE, setSaveInProject, stateFileFor,
  publicQuiz, publicState, touchViewer, viewerConnected, listProjects, letter,
};

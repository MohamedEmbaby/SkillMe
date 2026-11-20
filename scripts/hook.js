#!/usr/bin/env node
'use strict';
/**
 * SkillMe hooks for Claude Code.
 *   node hook.js session-start   -> tells Claude SkillMe is on + the rules + the scoreboard
 *   node hook.js post-tool-use   -> tracks AI reads/writes, nudges a quiz when due, relays user feedback
 *   node hook.js user-prompt     -> relays feedback that arrived while Claude was idle; reminds to log corrections
 *   node hook.js stop            -> before Claude ends a turn: handle feedback / push a final quiz about unquizzed changes
 * Never blocks Claude on errors: any failure exits 0 silently (logged to ~/.skillme/hook-errors.log).
 */
const fs = require('fs');
const path = require('path');
const core = require('../server/core');

const mode = process.argv[2];

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function out(obj) {
  if (obj) fs.writeSync(1, JSON.stringify(obj)); // sync write: safe to exit right after
  process.exit(0);
}

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function lineCount(s) { return s ? String(s).split('\n').length : 0; }

const ARENA_ONLY = 'They go to the SkillMe Arena (a browser page), where the user answers them: never ask, show or discuss quizzes in chat; just keep working.';

// The only thing the coding AI ever has to act on: fix requests from challenges the user won.
function actionable(events) {
  return events.filter((e) => e.type === 'fix');
}

const RULES = [
  'SkillMe (code-understanding duel) is ON. Rules:',
  '• While you write/change code, push SHORT quizzes with skillme_quiz (hooks tell you when they are due, about every 2 edits): 1 for a small change, 2-3 (different ideas) after a big one. Ask the WHY/what-happens/trade-off, not trivia.',
  '• Every quiz needs `context` (1-3 sentences: what the thing IS in this project) and should carry a `deep_dive` (shown instantly when the user asks for more).',
  `• ${ARENA_ONLY} A separate tutor AI answers the user's questions and judges their challenges there; you never answer those.`,
  '• When SkillMe relays a FIX REQUEST (the user won a challenge that exposed a real code problem), fix it before continuing.',
  '• When the user corrects you in chat (bug, wrong assumption, bad approach) and they are right, call skillme_correction. Be a good sport.',
  '• Keep it light and fun, never let quizzes derail the actual task, never plant bugs to quiz about. Details: the "skillme" skill.',
].join('\n');

function main() {
  if (process.env.SKILLME_DISABLE === '1') out(); // opt-out switch, e.g. for scripted sessions
  const input = readStdin();
  const root = core.findRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const slug = core.projectSlug(root);
  const cfg = core.getConfig();
  if (cfg.mode === 'off') out();

  if (mode === 'session-start') {
    const line = core.updateState(root, (s) => { core.refreshTotalFiles(s, root); return s.paused ? null : core.scoreLine(s); });
    if (!line) out();
    const url = `http://127.0.0.1:${cfg.port}/?p=${slug}`;
    const watching = core.viewerConnected(slug);
    out(context('SessionStart', `${RULES}\nScoreboard: ${line}\nArena: ${url}${watching ? ' (the user has it open)' : ' (not open yet; it opens automatically with the first quizzes)'}`));
  }

  if (mode === 'post-tool-use') {
    const t = input.tool_name || '';
    const ti = input.tool_input || {};
    let file = ti.file_path || ti.notebook_path;
    let action = null, lines = 0, partial = false;
    if (t === 'Read') { action = 'read'; partial = !!(ti.offset || ti.limit); }
    else if (t === 'Write') { action = 'write'; lines = lineCount(ti.content); }
    else if (t === 'Edit') { action = 'write'; lines = Math.max(lineCount(ti.new_string), 1); }
    else if (t === 'MultiEdit') { action = 'write'; lines = (ti.edits || []).reduce((n, e) => n + Math.max(lineCount(e.new_string), 1), 0); }
    else if (t === 'NotebookEdit') { action = 'write'; lines = Math.max(lineCount(ti.new_source), 1); }
    if (!action || !file) out();

    const res = core.updateState(root, (s) => {
      if (s.paused) return null;
      const u = core.trackActivity(s, root, file, action, lines, { partial });
      const events = actionable(s.events.filter((e) => !e.delivered));
      for (const e of events) e.delivered = true;
      const c = s.counters;
      const pending = s.quizzes.filter((q) => q.status === 'pending' && !q.replay).length; // replays don't block new quizzes
      const due = u && action === 'write' &&
        (c.editsSinceQuiz >= cfg.quizEveryEdits || c.linesSinceQuiz >= cfg.quizEveryLines) &&
        Date.now() - (c.lastNudgeAt || 0) >= cfg.minSecondsBetweenNudges * 1000 &&
        pending < cfg.maxPending;
      if (due) c.lastNudgeAt = Date.now();
      return {
        due, files: c.filesSinceQuiz.slice(), lines: c.linesSinceQuiz,
        events: events.length ? core.describeEvents(events, s) : '',
        difficulty: core.suggestedDifficulty(s), weak: core.weakConcepts(s), line: core.scoreLine(s),
      };
    });
    if (!res || (!res.due && !res.events)) out();
    const parts = [];
    if (res.due) {
      const count = res.lines >= 80 || res.files.length >= 3 ? '2-3 quizzes (one per distinct idea)' : '1 quiz';
      parts.push(`SkillMe: quizzes due — you changed ${res.files.join(', ')} (~${res.lines} lines) since the last ones. ` +
        `Push ${count} now in ONE skillme_quiz call about the most important ideas in these changes; each needs a \`context\` and ideally a \`deep_dive\` ` +
        `(suggested difficulty ${res.difficulty}${res.weak.length ? `; the user is weak on: ${res.weak.join(', ')}` : ''}). ${ARENA_ONLY}`);
    }
    if (res.events) parts.push(`SkillMe:\n${res.events}`);
    parts.push(res.line);
    out(context('PostToolUse', parts.join('\n')));
  }

  if (mode === 'user-prompt') {
    const prompt = String(input.prompt || '');
    const res = core.updateState(root, (s) => {
      if (s.paused) return null;
      const events = actionable(s.events.filter((e) => !e.delivered));
      for (const e of events) e.delivered = true;
      return { events: events.length ? core.describeEvents(events, s) : '' };
    });
    if (!res) out();
    const parts = [];
    if (res.events) parts.push(`SkillMe:\n${res.events}`);
    if (/\b(wrong|incorrect|mistake|bug|broke|broken|doesn'?t work|not working|you forgot|you missed|that'?s not|should(n'?t)? be|typo|why did you)\b/i.test(prompt)) {
      parts.push('SkillMe: if this message corrects a mistake you made (and the user is right), call skillme_correction before fixing it.');
    }
    out(parts.length ? context('UserPromptSubmit', parts.join('\n')) : null);
  }

  if (mode === 'stop') {
    if (input.stop_hook_active) out();
    const res = core.updateState(root, (s) => {
      if (s.paused) return null;
      const events = actionable(s.events.filter((e) => !e.delivered));
      for (const e of events) e.delivered = true;
      const c = s.counters;
      const pending = s.quizzes.filter((q) => q.status === 'pending' && !q.replay).length; // replays don't block new quizzes
      const needQuiz = cfg.stopHookQuiz && (c.editsSinceQuiz >= 2 || c.linesSinceQuiz >= 10) && pending < cfg.maxPending;
      if (needQuiz) c.lastNudgeAt = Date.now();
      return { events: events.length ? core.describeEvents(events, s) : '', needQuiz, files: c.filesSinceQuiz.slice(), difficulty: core.suggestedDifficulty(s) };
    });
    if (!res || (!res.events && !res.needQuiz)) out();
    const parts = ['SkillMe, before you finish:'];
    if (res.events) parts.push(res.events);
    if (res.needQuiz) parts.push(`• You changed ${res.files.join(', ')} without quizzes yet. Push 1-2 short final quizzes (one skillme_quiz call, with \`context\`, difficulty ${res.difficulty}) about the key ideas of this change. ${ARENA_ONLY}`);
    parts.push('Then finish your reply as normal.');
    out({ decision: 'block', reason: parts.join('\n') });
  }

  out();
}

try { main(); } catch (e) {
  try {
    fs.mkdirSync(core.HOME, { recursive: true });
    fs.appendFileSync(path.join(core.HOME, 'hook-errors.log'), `${new Date().toISOString()} ${mode}: ${e.stack || e}\n`);
  } catch {}
  process.exit(0);
}

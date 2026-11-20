#!/usr/bin/env node
'use strict';
/**
 * SkillMe statusline for Claude Code. Shows the duel score under the prompt:
 *   SkillMe  You 85 HP ████░ vs Claude 60 HP ███░░ · streak 3 · Lv3 Pair Programmer · 2 waiting
 * Configure in ~/.claude/settings.json:
 *   "statusLine": { "type": "command", "command": "node \"<path-to>/scripts/statusline.js\"" }
 */
const fs = require('fs');
const core = require('../server/core');

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
try {
  const dir = (input.workspace && (input.workspace.project_dir || input.workspace.current_dir)) || input.cwd || process.cwd();
  const root = core.findRoot(dir);
  const s = core.loadState(root);
  const sc = core.scores(s);
  const c = (n, t) => `\x1b[${n}m${t}\x1b[0m`;
  if (!Object.keys(s.units).length && !sc.answered) {
    process.stdout.write(c(2, 'SkillMe ready: the duel starts when the AI writes code'));
  } else {
    const parts = [
      `SkillMe  ${c(36, `You ${sc.hp.human} HP ${core.bar(sc.hp.human, 5)}`)} vs ${c(33, `Claude ${sc.hp.ai} HP ${core.bar(sc.hp.ai, 5)}`)}`,
      sc.streak ? `streak ${sc.streak}` : null,
      `Lv${sc.level} ${sc.title}`,
      sc.pending ? c(35, `${sc.pending} waiting`) : null,
      s.paused ? 'paused' : null,
    ].filter(Boolean);
    process.stdout.write(parts.join(' · '));
  }
} catch {
  process.stdout.write('SkillMe');
}

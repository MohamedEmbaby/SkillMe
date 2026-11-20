#!/usr/bin/env node
'use strict';
/**
 * SkillMe CLI: call any skillme_* tool from a shell. Lets agents without MCP (or without the plugin
 * installed) play — they just run commands. Arguments are JSON, given inline or on stdin:
 *
 *   node scripts/cli.js skillme_status '{"project":"/path/to/project"}'
 *   node scripts/cli.js skillme_quiz <<'EOF'
 *   { "project": "/path/to/project", "question": "...", "options": ["a","b"], "answer": 0, ... }
 *   EOF
 *   node scripts/cli.js arena            # serve the Arena (keep running)
 *   node scripts/cli.js tools            # list tools
 */
const fs = require('fs');
const path = require('path');

const [, , name, inline] = process.argv;

if (!name || name === '-h' || name === '--help') {
  console.log('usage: skillme <tool> [json]   |   skillme tools   |   skillme arena [--open]   |   skillme app [install]');
  process.exit(0);
}

if (name === 'app') {
  // The Arena in a window of its own (Electron runtime installed once into ~/.skillme/app).
  const app = require('../server/app');
  if (process.argv[3] === 'install') {
    console.log(`Installing the SkillMe window runtime (Electron ${app.ELECTRON_VERSION}, about 110 MB) into ${app.runtimeDir()} ...`);
    app.install().then((ok) => {
      console.log(ok ? 'Done. Open it with: node scripts/cli.js app' : 'Install failed: see the npm output above.');
      process.exit(ok ? 0 : 1);
    });
  } else if (app.launch(process.argv[3] || null)) {
    console.log('SkillMe Arena window opened.');
  } else {
    console.log('The window runtime is not installed yet. Run: node scripts/cli.js app install');
    process.exit(1);
  }
} else if (name === 'arena') {
  require('child_process').spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), '--arena', ...process.argv.slice(3)], { stdio: 'inherit' })
    .on('exit', (c) => process.exit(c || 0));
} else {
  process.env.SKILLME_NO_HOST = '1';
  const { callTool, TOOLS } = require('../server/index.js');
  if (name === 'tools') {
    for (const t of TOOLS) console.log(`${t.name.padEnd(26)} ${t.description.split('. ')[0]}.`);
    process.exit(0);
  }
  let raw = inline;
  if (!raw && !process.stdin.isTTY) raw = fs.readFileSync(0, 'utf8');
  let args = {};
  try { args = raw && raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
    console.error(`Invalid JSON arguments: ${e.message}`);
    process.exit(2);
  }
  const tool = name.startsWith('skillme_') ? name : `skillme_${name}`;
  callTool(tool, args).then((r) => {
    console.log(r.content.map((c) => c.text).join('\n'));
    process.exit(r.isError ? 1 : 0);
  }).catch((e) => { console.error(e.stack || e); process.exit(1); });
}

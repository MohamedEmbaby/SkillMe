'use strict';
/**
 * The SkillMe desktop window: the Arena in a window of its own instead of a browser tab.
 *
 * The window code lives in <plugin>/desktop (Electron). Only the Electron runtime is installed, once, into
 * ~/.skillme/app (`node scripts/cli.js app install`), so the plugin itself keeps zero dependencies and any
 * copy of the plugin can open the window. Without the runtime, SkillMe falls back to the browser.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core');

const ELECTRON_VERSION = '45.2.2'; // pinned exactly (no ^): the runtime is downloaded code, so updates are deliberate
const DESKTOP_DIR = path.join(__dirname, '..', 'desktop');
const runtimeDir = () => path.join(core.HOME, 'app');

/** Path of the Electron binary, read from electron/path.txt (no package code is executed). */
function electronPath() {
  for (const base of [runtimeDir(), DESKTOP_DIR]) {
    try {
      const pkg = path.join(base, 'node_modules', 'electron');
      const exe = path.join(pkg, 'dist', fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim());
      if (fs.existsSync(exe)) return exe;
    } catch {}
  }
  return null;
}

const installed = () => !!electronPath();

/** Open (or focus) the Arena window on a project. Returns false if the runtime isn't installed. */
function launch(slug) {
  const exe = electronPath();
  if (!exe) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // would turn the window app into a plain Node process
  try {
    spawn(exe, [DESKTOP_DIR, ...(slug ? [`--project=${slug}`] : [])], { detached: true, stdio: 'ignore', env }).unref();
    return true;
  } catch { return false; }
}

/**
 * Download the Electron runtime into ~/.skillme/app. Resolves to true when the window can open.
 * quiet: no output at all (required inside the MCP server, whose stdout is the JSON-RPC channel).
 */
function install({ quiet = false } = {}) {
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'skillme-window-runtime', private: true,
    description: 'Electron runtime for the SkillMe Arena window (the app code lives in the SkillMe plugin\'s desktop folder).',
    dependencies: { electron: ELECTRON_VERSION },
  }, null, 2));
  const run = (cmd, args, opts = {}) => new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: dir, stdio: quiet ? 'ignore' : 'inherit', windowsHide: true, ...opts });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code));
  });
  return (async () => {
    // 1) the npm package (small). Windows needs a shell to run npm.cmd; the arguments are fixed strings.
    if (process.platform === 'win32') { if (await run('npm install --no-audit --no-fund', [], { shell: true })) return false; }
    else if (await run('npm', ['install', '--no-audit', '--no-fund'])) return false;
    // 2) the runtime itself: Electron 45+ downloads it on demand, verified against the package's checksums.json.
    if (await run(process.execPath, [path.join(dir, 'node_modules', 'electron', 'install.js')])) return false;
    return installed();
  })();
}

module.exports = { ELECTRON_VERSION, DESKTOP_DIR, electronPath, installed, launch, install, runtimeDir };

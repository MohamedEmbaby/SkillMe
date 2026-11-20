'use strict';
/**
 * SkillMe Arena window (Electron main process).
 *
 * Opens the Arena in a window of its own. It hosts the Arena server itself when no AI session does
 * (and takes over if that session closes), so the window keeps working on its own.
 * Started by SkillMe (`--project=<slug>`) or by hand: node scripts/cli.js app
 */
const { app, BrowserWindow, shell, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const server = require('../server/index.js'); // ensureArena(): host the Arena here, or find the one already running
const core = require('../server/core');

const argProject = (argv) => {
  const a = argv.find((x) => x.startsWith('--project='));
  return a ? a.slice('--project='.length) : null;
};
const boundsFile = path.join(core.HOME, 'window.json');
const readBounds = () => { try { return JSON.parse(fs.readFileSync(boundsFile, 'utf8')); } catch { return {}; } };

let win = null;
let origin = null;

// ---------------------------------------------------------------- window icon: the player (your knight)
// assets/sprites/icon-player.png is cut from the art sheets by scripts/build-atlas.js; the crest is the fallback.
function playerIcon() {
  const sprites = path.join(__dirname, '..', 'assets', 'sprites');
  for (const name of ['icon-player.png', 'emblem-app.png']) {
    const img = nativeImage.createFromPath(path.join(sprites, name));
    if (!img.isEmpty()) return img;
  }
  return undefined;
}

// ---------------------------------------------------------------- the window
function projectUrl(base, slug) {
  return slug ? `${base}/?p=${encodeURIComponent(slug)}` : `${base}/`;
}

async function open(slug) {
  const base = await server.ensureArena();
  if (!base) throw new Error('Could not start the SkillMe Arena server');
  origin = base;
  if (win) {
    if (slug) win.loadURL(projectUrl(base, slug));
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    return;
  }
  const saved = readBounds();
  win = new BrowserWindow({
    width: saved.width || 980, height: saved.height || 900, x: saved.x, y: saved.y,
    minWidth: 380, minHeight: 520,
    // No OS frame: the Arena page draws its own game-styled title bar and buttons (still resizable from the edges).
    frame: false,
    title: 'SkillMe Arena', icon: playerIcon(), backgroundColor: '#1d1409', show: false, autoHideMenuBar: true,
    alwaysOnTop: !!saved.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => { if (saved.maximized) win.maximize(); win.show(); });
  const sendMax = () => win && win.webContents.send('skillme:maximized', win.isMaximized());
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  // Only the Arena runs inside the window; links (e.g. "get an OpenRouter key") open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) e.preventDefault(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) { win.webContents.reload(); e.preventDefault(); }
    if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.on('close', () => {
    try { fs.writeFileSync(boundsFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized(), alwaysOnTop: win.isAlwaysOnTop() })); } catch {}
  });
  win.on('closed', () => { win = null; });
  win.loadURL(projectUrl(base, slug));
}

ipcMain.handle('skillme:get-pinned', () => !!(win && win.isAlwaysOnTop()));
ipcMain.handle('skillme:set-pinned', (_e, on) => { if (win) win.setAlwaysOnTop(!!on); return !!(win && win.isAlwaysOnTop()); });
// The title bar's buttons (the page has no other access to the window).
ipcMain.handle('skillme:window', (_e, action) => {
  if (!win) return null;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') { win.close(); return null; }
  return { maximized: win.isMaximized() };
});

if (!app.requestSingleInstanceLock()) {
  app.quit(); // already open: the running window gets 'second-instance' and switches project
} else {
  app.setAppUserModelId('SkillMe.Arena');
  app.on('second-instance', (_e, argv) => { open(argProject(argv)).catch(() => {}); });
  app.whenReady().then(() => open(argProject(process.argv))).catch((e) => { console.error(e); app.quit(); });
  // If the AI session that hosted the Arena closes, this window takes over hosting it.
  setInterval(() => { server.ensureArena().catch(() => {}); }, 5000).unref();
  app.on('window-all-closed', () => app.quit());
}

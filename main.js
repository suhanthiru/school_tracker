'use strict';

const {
  app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog,
  Notification, globalShortcut, session,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Windows toast attribution needs a stable app user model id, set before ready.
app.setAppUserModelId('com.suhan.school-tracker');

const server = require('./server');
const bridge = require('./lib/bridge');

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const GRADESCOPE_PARTITION = 'persist:gradescope';

let db = null;
let sync = null;
let scheduler = null;

let win = null;
let tray = null;
let captureWin = null;
let gsWin = null;
let serverPort = null;
let quitting = false;

// Launched by the Windows login item — start in the tray unless this is the
// first activation of the day (see maybeShowDaily).
const startHidden = process.argv.includes('--hidden');

// One tracker, one database. A second launch just focuses the window we have.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { maybeShowDaily(true); });
  app.whenReady().then(boot);
}

async function boot() {
  try {
    // Required lazily so db.js resolves the packaged userData path correctly.
    db = require('./lib/db');
    sync = require('./lib/sync');
    scheduler = require('./lib/scheduler');

    const started = await server.start(0);
    serverPort = started.port;
  } catch (err) {
    dialog.showErrorBox('School Tracker', `Could not start the app:\n\n${err.message}`);
    app.exit(1);
    return;
  }

  registerAutoStart();
  createTray();
  wireBridge();
  registerCaptureHotkey();
  scheduler.start();

  maybeShowDaily(!startHidden);

  app.on('activate', () => { showWindow(); });
}

/**
 * The first activation of each calendar day shows the radar front-and-center —
 * a deliberate morning look at the workload. Any other launch respects
 * --hidden and lives in the tray.
 */
function maybeShowDaily(explicit) {
  const today = new Date();
  const key = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
  const firstToday = db.getSetting('last_shown_date') !== key;
  if (explicit || firstToday) {
    db.setSetting('last_shown_date', key);
    showWindow();
  }
}

function icon() {
  if (fs.existsSync(ICON_PATH)) {
    const img = nativeImage.createFromPath(ICON_PATH);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function createWindow() {
  if (win) return;

  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0c0f14',
    icon: icon(),
    title: 'School Tracker',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.loadURL(`http://127.0.0.1:${serverPort}/`);
  win.once('ready-to-show', () => win.show());

  // Assignment links belong in the real browser, not in an app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window keeps the engine alive: syncs, toasts, and the morning
  // digest continue. Quit deliberately from the tray.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  win.on('closed', () => { win = null; });
}

function showWindow(route = null) {
  if (!win) createWindow();
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  if (route) {
    win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)};`)
      .catch(() => { /* window may still be loading */ });
  }
}

function createTray() {
  const img = icon();
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('School Tracker');

  const menu = Menu.buildFromTemplate([
    { label: 'Open School Tracker', click: () => showWindow() },
    { label: 'Quick add task', click: openCaptureWindow },
    { type: 'separator' },
    {
      label: 'Sync now',
      click: () => { sync.sync().catch((err) => console.error('[tray sync]', err)); },
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => setAutoStart(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function setAutoStart(enabled) {
  // In dev the login item must point at electron.exe with this project as its
  // argument; a packaged build points at the app exe itself.
  const options = { openAtLogin: enabled, args: ['--hidden'] };
  if (!app.isPackaged) {
    options.path = process.execPath;
    options.args = [path.resolve(__dirname), '--hidden'];
  }
  app.setLoginItemSettings(options);
}

function registerAutoStart() {
  // Set it up on first run; after that respect whatever the user chose.
  if (!app.getLoginItemSettings().openAtLogin) setAutoStart(true);
}

// ---------- bridge: lib code asking the shell for things ----------

function wireBridge() {
  bridge.on('toast', (t) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: t.title, body: t.body || '', icon: icon() });
    n.on('click', () => showWindow(t.route || null));
    n.show();
  });

  bridge.on('gradescope-login', openGradescopeLogin);

  bridge.on('gradescope-logout', () => {
    session.fromPartition(GRADESCOPE_PARTITION).clearStorageData()
      .catch((err) => console.error('[gradescope logout]', err));
  });

  bridge.on('hotkey-changed', registerCaptureHotkey);
}

// ---------- Gradescope SSO window ----------

function openGradescopeLogin() {
  if (gsWin) { gsWin.focus(); return; }

  gsWin = new BrowserWindow({
    width: 520,
    height: 720,
    title: 'Sign in to Gradescope',
    autoHideMenuBar: true,
    webPreferences: {
      partition: GRADESCOPE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  gsWin.loadURL('https://www.gradescope.com/login');

  // GT SSO + Duo bounce through several hosts; success is landing back on the
  // Gradescope dashboard.
  const onNav = (_e, url) => {
    let u;
    try { u = new URL(url); } catch { return; }
    if (!/(^|\.)gradescope\.com$/.test(u.hostname)) return;
    if (u.pathname === '/' || u.pathname === '/account' || u.pathname === '/home') {
      db.setSetting('gradescope_state', 'ok');
      setTimeout(() => { if (gsWin) gsWin.close(); }, 700);
      sync.syncOne('gradescope').catch((err) => console.error('[gradescope first sync]', err));
    }
  };
  gsWin.webContents.on('did-navigate', onNav);
  gsWin.webContents.on('did-redirect-navigation', onNav);

  gsWin.on('closed', () => { gsWin = null; });
}

// ---------- quick capture ----------

function registerCaptureHotkey() {
  globalShortcut.unregisterAll();
  const accel = db.getSetting('capture_hotkey', 'Control+Shift+Space');
  if (!accel) return;
  try {
    const okReg = globalShortcut.register(accel, openCaptureWindow);
    db.setSetting('capture_hotkey_ok', okReg ? '1' : '0');
    if (!okReg) console.warn(`[capture] hotkey ${accel} is taken by another app`);
  } catch (err) {
    db.setSetting('capture_hotkey_ok', '0');
    console.warn(`[capture] bad hotkey ${accel}: ${err.message}`);
  }
}

function openCaptureWindow() {
  if (captureWin) { captureWin.focus(); return; }

  captureWin = new BrowserWindow({
    width: 560,
    height: 76,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#151a22',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  captureWin.loadURL(`http://127.0.0.1:${serverPort}/capture.html`);
  captureWin.once('ready-to-show', () => captureWin.show());
  captureWin.on('blur', () => { if (captureWin) captureWin.close(); });
  captureWin.on('closed', () => { captureWin = null; });
}

// ---------- lifecycle ----------

app.on('window-all-closed', () => {
  // Deliberately empty: the tray keeps the app alive.
});

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => { globalShortcut.unregisterAll(); });

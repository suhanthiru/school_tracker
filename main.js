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

// Services the app signs into with a real login window (school SSO + Duo),
// keeping the session in a persistent partition. Canvas is here because GT
// blocks student-created access tokens; its REST API accepts the session.
const SSO_SERVICES = {
  gradescope: {
    label: 'Gradescope',
    partition: 'persist:gradescope',
    stateKey: 'gradescope_state',
    loginUrl: () => 'https://www.gradescope.com/login',
    isDashboard: (u) => /(^|\.)gradescope\.com$/.test(u.hostname)
      && ['/', '/account', '/home'].includes(u.pathname),
  },
  canvas: {
    label: 'Canvas',
    partition: 'persist:canvas',
    stateKey: 'canvas_state',
    loginUrl: () => `${String(db.getSetting('canvas_base_url', '')).replace(/\/+$/, '')}/login`,
    isDashboard: (u) => {
      try {
        const base = new URL(db.getSetting('canvas_base_url', ''));
        return u.hostname === base.hostname
          && (u.pathname === '/' || u.pathname === '/dashboard' || u.pathname.startsWith('/?'));
      } catch { return false; }
    },
  },
};

let db = null;
let sync = null;
let scheduler = null;

let win = null;
let tray = null;
let captureWin = null;
const ssoWins = {};
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

    // Random loopback port normally; SCHOOL_TRACKER_PORT pins it (debugging).
    const started = await server.start(Number(process.env.SCHOOL_TRACKER_PORT || 0));
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

  // Belt and suspenders for the SSO sessions: flush their cookie jars to
  // disk every few minutes so no kind of exit loses a login.
  const flushSessions = () => {
    for (const svc of Object.values(SSO_SERVICES)) {
      try { session.fromPartition(svc.partition).flushStorageData(); } catch { /* best effort */ }
    }
  };
  const flushTimer = setInterval(flushSessions, 5 * 60 * 1000);
  if (flushTimer.unref) flushTimer.unref();

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

  bridge.on('sso-login', (service) => openSsoLogin(service));

  bridge.on('sso-logout', (service) => {
    const svc = SSO_SERVICES[service];
    if (!svc) return;
    session.fromPartition(svc.partition).clearStorageData()
      .catch((err) => console.error(`[${service} logout]`, err));
  });

  bridge.on('hotkey-changed', registerCaptureHotkey);

  bridge.on('quit', () => { quitting = true; app.quit(); });

  bridge.on('syllabus-pick', ({ onFile }) => {
    dialog.showOpenDialog({
      title: 'Choose a syllabus',
      filters: [
        { name: 'Syllabus', extensions: ['pdf', 'docx', 'txt', 'md'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    }).then(({ canceled, filePaths }) => {
      if (!canceled && filePaths[0]) onFile(filePaths[0]);
    }).catch((err) => console.error('[syllabus pick]', err));
  });
}

// ---------- SSO login windows (Gradescope, Canvas) ----------

function openSsoLogin(service) {
  const svc = SSO_SERVICES[service];
  if (!svc) return;
  if (ssoWins[service]) { ssoWins[service].focus(); return; }

  const w = ssoWins[service] = new BrowserWindow({
    width: 520,
    height: 720,
    title: `Sign in to ${svc.label}`,
    autoHideMenuBar: true,
    webPreferences: {
      partition: svc.partition,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  w.loadURL(svc.loginUrl());

  // School SSO + Duo bounce through several hosts; success is landing back on
  // the service's own dashboard.
  const onNav = (_e, url) => {
    let u;
    try { u = new URL(url); } catch { return; }
    if (!svc.isDashboard(u)) return;
    db.setSetting(svc.stateKey, 'ok');
    // Chromium writes cookies lazily; force them to disk NOW so a later
    // crash or kill cannot eat the session the user just signed into.
    session.fromPartition(svc.partition).flushStorageData();
    setTimeout(() => { if (ssoWins[service]) ssoWins[service].close(); }, 700);
    sync.syncOne(service).catch((err) => console.error(`[${service} first sync]`, err));
  };
  w.webContents.on('did-navigate', onNav);
  w.webContents.on('did-redirect-navigation', onNav);

  w.on('closed', () => { ssoWins[service] = null; });
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

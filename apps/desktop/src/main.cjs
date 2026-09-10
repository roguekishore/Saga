// @ts-check
'use strict';

/**
 * SAGA desktop shell (~200 LOC by design). Electron rather than Tauri because
 * Tauri requires cargo + MSVC — heavier toolchain dependencies. The collector
 * ships as a Bun sidecar, so swapping this shell for Tauri later touches
 * nothing else.
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell } = require('electron');
const path = require('node:path');
const { sidecarPlan, startSidecar, waitForHealth } = require('./sidecar.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_PORT = Number(process.env.SAGA_API_PORT || 8788);
const BASE_URL = `http://127.0.0.1:${API_PORT}`;

/** @type {{ child: import('node:child_process').ChildProcess, stop: () => void } | null} */
let sidecar = null;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;

// One SAGA per machine: two proxies fighting over :8787 helps no one.
const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(boot);
}

async function boot() {
  // If a collector is already running (dev workflow), attach; else spawn.
  let attached = await waitForHealth(BASE_URL, 500);
  if (!attached) {
    const plan = sidecarPlan({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot: REPO_ROOT,
      userDataDir: app.getPath('userData'),
    });
    sidecar = startSidecar(plan);
    attached = await waitForHealth(BASE_URL, 15000);
  }

  if (!attached) {
    dialog.showErrorBox(
      'SAGA collector failed to start',
      app.isPackaged
        ? `No health response on ${BASE_URL}. Are ports 8787/8788 free?`
        : `No health response on ${BASE_URL}. Is bun installed and are ports 8787/8788 free?`,
    );
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0d10',
    title: 'SAGA',
    autoHideMenuBar: true,
    webPreferences: {
      // The UI is a plain web app talking to loopback HTTP — no Node in the
      // renderer, no preload surface to defend.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // External links open in the OS browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  await win.loadURL(BASE_URL);
  win.on('closed', () => {
    win = null;
  });

  setupTray();
}

function setupTray() {
  // 16x16 amber square — placeholder mark, replaced by real iconography later.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVQ4T2P8z8Dwn4ECwDhqAMOoAQyjBjCMGsAwagDDqAEMw8QAAJyCEAGyoNCzAAAAAElFTkSuQmCC',
  );
  tray = new Tray(icon);
  tray.setToolTip('SAGA — gateway observability');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open SAGA',
        click: () => {
          if (win) win.show();
        },
      },
      { label: `proxy 127.0.0.1:8787 · api ${API_PORT}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

app.on('window-all-closed', () => {
  // Windows tray app semantics: closing the window keeps capture running;
  // quitting happens from the tray menu.
});

app.on('before-quit', () => {
  sidecar?.stop();
});

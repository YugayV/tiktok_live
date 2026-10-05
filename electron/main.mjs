// Desktop shell: runs the TikLive server in-process and shows the dashboard in a window.
// Overlays stay available at http://127.0.0.1:<port>/overlay/... for OBS.

import { app, BrowserWindow, Tray, Menu, shell, clipboard, globalShortcut, nativeImage, dialog } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server-app.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFERRED_PORT = Number(process.env.PORT) || 8787;
const PANIC_HOTKEY = 'CommandOrControl+Shift+F12';

let win = null;
let tray = null;
let server = null;
let base = '';
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();

async function boot() {
  const dataDir = join(app.getPath('userData'), 'data');
  const opts = { host: '127.0.0.1', dataDir, demo: process.argv.includes('--demo') };
  try {
    server = startServer({ ...opts, port: PREFERRED_PORT });
    base = await server.ready;
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    // Another copy (or the CLI) holds the port: fall back to a free one and warn, since OBS URLs change.
    server = startServer({ ...opts, port: 0 });
    base = await server.ready;
    dialog.showMessageBox({ type: 'warning', message: `Порт ${PREFERRED_PORT} занят`, detail: `TikLive запущен на ${base}. Обновите адреса оверлеев в OBS или закройте программу, занимающую порт.` });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 420,
    backgroundColor: '#0e0f14',
    title: 'TikLive Studio',
    icon: join(HERE, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(`${base}/`);
  // Links to other sites (docs, TikTok) open in the system browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(base)) shell.openExternal(url);
    return { action: url.startsWith(base) ? 'allow' : 'deny' };
  });
  // Closing the window keeps the server (and OBS overlays) running in the tray.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

async function panicStop() {
  await server?.studio.keys.stop();
  server?.studio.logLine('🛑 Аварийная остановка клавиш');
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(join(HERE, 'tray.png')));
  tray.setToolTip('TikLive Studio');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть панель', click: showWindow },
      { label: 'Открыть в браузере', click: () => shell.openExternal(`${base}/`) },
      { label: 'Скопировать URL алертов для OBS', click: () => clipboard.writeText(`${base}/overlay/?w=alerts`) },
      { type: 'separator' },
      { label: `Аварийная остановка клавиш (${PANIC_HOTKEY})`, click: panicStop },
      { type: 'separator' },
      { label: 'Выход', click: () => ((quitting = true), app.quit()) },
    ]),
  );
  tray.on('click', showWindow);
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  try {
    await boot();
  } catch (err) {
    dialog.showErrorBox('TikLive Studio', `Не удалось запустить сервер: ${err.message}`);
    app.exit(1);
    return;
  }
  createTray();
  createWindow();
  globalShortcut.register(PANIC_HOTKEY, panicStop);
});

app.on('activate', showWindow); // macOS dock click
app.on('window-all-closed', () => {}); // keep running in tray
app.on('before-quit', () => (quitting = true));
app.on('will-quit', async (e) => {
  globalShortcut.unregisterAll();
  if (!server) return;
  e.preventDefault();
  const s = server;
  server = null;
  await s.close().catch(() => {});
  app.exit(0);
});

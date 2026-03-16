const { app, BrowserWindow, Tray, Menu, shell, globalShortcut } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const SERVER_PORT = 3456;
const CHECK_INTERVAL = 1000;
const MAX_WAIT = 30000;

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverManaged = false;

function isServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${SERVER_PORT}/health`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.status === 'ok');
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  const running = await isServerRunning();
  if (running) {
    console.log('Server already running on port ' + SERVER_PORT);
    return;
  }

  console.log('Starting server from ' + SERVER_DIR);

  const distPath = path.join(SERVER_DIR, 'dist', 'index.js');
  if (!fs.existsSync(distPath)) {
    console.log('Building server...');
    try {
      execSync('npx tsc', { cwd: SERVER_DIR, stdio: 'inherit' });
    } catch (err) {
      console.error('Build failed:', err.message);
    }
  }

  serverProcess = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env },
  });

  serverProcess.stdout.on('data', (data) => {
    console.log('[Server] ' + data.toString().trim());
  });
  serverProcess.stderr.on('data', (data) => {
    console.error('[Server] ' + data.toString().trim());
  });
  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err.message);
  });
  serverProcess.on('close', (code) => {
    console.log('Server exited with code ' + code);
    serverProcess = null;
  });

  serverManaged = true;

  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    const ready = await isServerRunning();
    if (ready) {
      console.log('Server is ready');
      return;
    }
    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }
  console.warn('Server did not start within ' + (MAX_WAIT / 1000) + 's');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: 'Mobile Claude',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);

  // Remove default menu bar
  mainWindow.setMenuBarVisibility(false);

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTrayIcon() {
  const { nativeImage } = require('electron');
  const w = 16, h = 16;
  const navy = [0x1a, 0x1a, 0x2e, 0xff];
  const gold = [0xd4, 0xa8, 0x43, 0xff];

  const pixels = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) pixels.set(navy, i * 4);
  const c = [
    [5,3],[6,3],[7,3],[8,3],[9,3],[10,3],
    [4,4],[5,4],[11,4],
    [3,5],[4,5],[3,6],[4,6],
    [3,7],[3,8],[3,9],
    [3,10],[4,10],[3,11],[4,11],
    [4,12],[5,12],[11,12],
    [5,13],[6,13],[7,13],[8,13],[9,13],[10,13],
  ];
  for (const [x, y] of c) pixels.set(gold, (y * w + x) * 4);

  return nativeImage.createFromBuffer(pixels, { width: w, height: h });
}

function createTray() {
  tray = new Tray(createTrayIcon());

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Mobile Claude', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Open in Browser', click: () => { shell.openExternal(`http://localhost:${SERVER_PORT}`); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('Mobile Claude');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.focus();
      else { mainWindow.show(); mainWindow.focus(); }
    }
  });
}

// Auto-start on login
const startHidden = process.argv.includes('--hidden');
if (!startHidden) {
  // Only set login item when launched normally (not during dev)
  app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
}

app.whenReady().then(async () => {
  await startServer();
  createTray();
  createWindow();

  if (startHidden && mainWindow) {
    mainWindow.hide();
  }

  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) { mainWindow.hide(); }
      else { mainWindow.show(); mainWindow.focus(); }
    }
  });
});

app.on('window-all-closed', () => {
  // Keep running in tray
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
  else mainWindow.show();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  if (serverManaged && serverProcess) {
    console.log('Stopping server...');
    serverProcess.kill();
  }
});

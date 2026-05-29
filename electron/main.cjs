// @ts-check
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SIGNAL_PATH = path.join(PROJECT_ROOT, 'data', 'current-signal.json');
const SAMPLE_PATH = path.join(PROJECT_ROOT, 'data', 'sample-signal.json');
const REFRESH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'refresh-signal.mjs');

const DEV_URL = process.env.ELECTRON_START_URL;
const IS_DEV = Boolean(DEV_URL);

// Tall enough for mascot + speech bubble + expanded panel headroom.
const STRIP_HEIGHT = 640;

/** @type {BrowserWindow | null} */
let mainWindow = null;

function computeStripBounds() {
  // Use display.bounds (NOT workArea) so the window can extend over the Dock —
  // that's what lets the mascot "stand on" the Dock surface like in the video.
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  return {
    x,
    y: y + height - STRIP_HEIGHT,
    width,
    height: STRIP_HEIGHT,
  };
}

async function createWindow() {
  const bounds = computeStripBounds();

  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'tiny hermes',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: IS_DEV,
    },
  });

  // 'screen-saver' level keeps us above the Dock on macOS.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  // Click-capturing by default. We tried per-region passthrough toggling on
  // mousemove, but the IPC round-trip introduced race conditions where the
  // window hadn't disabled passthrough yet by the time the mousedown landed.
  // Net effect: clicks land reliably on the mascot/bubble/panel. The cost is
  // that clicks on the Dock that fall under the strip are absorbed by us —
  // use Cmd+Tab or the Dock's auto-show edge instead.
  mainWindow.setIgnoreMouseEvents(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (IS_DEV && DEV_URL) {
    await mainWindow.loadURL(DEV_URL);
  } else {
    await mainWindow.loadFile(path.join(PROJECT_ROOT, 'dist', 'index.html'));
  }
}

async function readSignalFile() {
  try {
    const raw = await fs.readFile(SIGNAL_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    try {
      const fallback = await fs.readFile(SAMPLE_PATH, 'utf8');
      return JSON.parse(fallback);
    } catch {
      return makeFallbackSignal();
    }
  }
}

function makeFallbackSignal() {
  return {
    id: 'fallback-empty',
    title: 'all quiet, pasha',
    summary: 'no strong signal right now.',
    source: 'tiny hermes',
    sourcePath: '',
    url: null,
    kind: 'generic',
    priority: 'low',
    timestamp: new Date().toISOString(),
    rawExcerpt: '',
  };
}

function runRefreshScript() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REFRESH_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    });
    child.once('exit', () => resolve(undefined));
    child.once('error', () => resolve(undefined));
  });
}

function registerIpc() {
  ipcMain.handle('signal:get', async () => {
    return readSignalFile();
  });

  ipcMain.handle('signal:refresh', async () => {
    await runRefreshScript();
    return readSignalFile();
  });

  ipcMain.handle('window:quit', () => {
    app.quit();
  });

  ipcMain.handle('window:open-external', async (_event, url) => {
    if (typeof url !== 'string') return false;
    if (!/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('window:set-interactive', (_event, interactive) => {
    if (!mainWindow) return;
    if (interactive) {
      mainWindow.setIgnoreMouseEvents(false);
    } else {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  ipcMain.handle('window:get-bounds', () => {
    const display = screen.getPrimaryDisplay();
    const bottomDockInset =
      display.bounds.y + display.bounds.height - (display.workArea.y + display.workArea.height);
    return {
      stripWidth: display.bounds.width,
      stripHeight: STRIP_HEIGHT,
      workAreaHeight: display.workArea.height,
      dockHeight: display.bounds.height - display.workArea.height,
      bottomDockInset,
    };
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
});

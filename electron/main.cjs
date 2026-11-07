const { app, BrowserWindow, dialog, ipcMain, shell, Notification } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const isDev = !app.isPackaged;
const START_URL = process.env.GULTRA_DEV_URL;
// Development only: photographs the screens for checking. Not present in the installed app.
const SHOT_DIR = isDev ? process.env.GULTRA_SHOT_DIR : null;

// ---- native helper ----
class Helper {
  constructor(getWin) {
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.child = null;
    this.stopped = false;
    this.getWin = getWin;
    this.restarts = 0;
    this.start();
  }

  exePath() {
    return isDev
      ? path.join(__dirname, 'helper', 'bin', 'GUltraHelper.exe')
      : path.join(process.resourcesPath, 'helper', 'GUltraHelper.exe');
  }

  start() {
    this.buf = '';
    const child = spawn(this.exePath(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => this.onData(d));
    child.on('error', (err) => this.failAll(err.message));
    child.on('exit', () => {
      this.failAll('The helper stopped.');
      if (this.stopped) return;
      // Restart with a growing pause if it exits unexpectedly.
      this.restarts += 1;
      setTimeout(() => this.start(), Math.min(10000, 500 * this.restarts));
    });
  }

  onData(chunk) {
    this.buf += chunk.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event) {
        const win = this.getWin();
        if (win && !win.isDestroyed()) win.webContents.send('helper-event', msg.event, msg.data);
      } else if (this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      }
    }
  }

  failAll(message) {
    for (const { reject } of this.pending.values()) reject(new Error(message));
    this.pending.clear();
  }

  call(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) return reject(new Error('The helper is not running.'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
    });
  }

  // Closing stdin makes the helper hand the fans back to automatic and exit by itself.
  stop() {
    this.stopped = true;
    try {
      this.child?.stdin.end();
    } catch {}
  }

  // The installer can't replace the helper's files while it's still running.
  stopAndWait(ms) {
    return new Promise((resolve) => {
      const child = this.child;
      this.stop();
      if (!child || child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, ms);
    });
  }

  resume() {
    this.stopped = false;
    if (!this.child || this.child.exitCode !== null) this.start();
  }
}

// What the UI may ask for. Anything that decides which paths get deleted stays in the helper.
const ALLOWED = new Set([
  'system', 'live', 'memory', 'freeRam', 'endProcess', 'disks', 'health',
  'cleanScan', 'cleanRun', 'cleanCancel', 'scanStart', 'scanCancel', 'scanNode',
  'sensorsReload', 'fanSet', 'fanAuto', 'fanAutoAll',
  'gpuInfo', 'gpuPowerLimit', 'gpuClockLimit', 'gpuClockReset', 'gpuPrefSet', 'hagsSet',
  'batteryInfo', 'batteryReport', 'batterySet', 'startupList', 'startupSet', 'components',
  'monitorGet', 'monitorSet', 'monitorHistory', 'autostartSet',
  'ramHealth', 'ramTestStart', 'ramTestCancel', 'ramDiagnostic',
  'driversScan', 'driversInstalled', 'driversInstall',
  'cpuTuning', 'cpuTuningMode', 'cpuTuningSet', 'overclockToolOpen', 'appEfficiencySet', 'appEfficiencyState', 'gpuApps',
  'binList', 'binRestore', 'recoverDrives', 'recoverStart', 'recoverCancel', 'recoverList', 'recoverRun',
]);

let win = null;
let helper = null;
let relaunching = false;

// When the window closes, only the small helper stays, with its icon next to the clock.
function startBackgroundMonitor() {
  if (!app.isPackaged || SHOT_DIR || relaunching) return;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'G Ultra', 'monitor.json'), 'utf8'));
    if (config.enabled === false) return;
  } catch {
    // No settings yet means the defaults, and monitoring is on by default.
  }
  try {
    spawn(helper.exePath(), ['--background'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}
const iconCache = new Map();

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0b0c10',
    show: false,
    title: 'G Ultra',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !SHOT_DIR,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => {
    if (SHOT_DIR) {
      win.setSkipTaskbar(true);
      win.setPosition(-4000, 0);
      win.showInactive();
    } else {
      win.show();
    }
  });

  // External links never open inside the app window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !(START_URL && url.startsWith(START_URL))) e.preventDefault();
  });

  if (START_URL) win.loadURL(START_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  if (SHOT_DIR) require('./shots.cjs')(win, app);
}

// ---- restart with admin rights ----
function relaunchElevated() {
  return new Promise((resolve) => {
    const exe = process.execPath;
    const args = isDev ? [app.getAppPath()] : [];
    const argList = args.length ? ` -ArgumentList '${args.map((a) => `"${a.replace(/'/g, "''")}"`).join(',')}'` : '';
    const command = `Start-Process -FilePath '${exe.replace(/'/g, "''")}'${argList} -Verb RunAs`;
    // Release the single-instance lock so the new instance can start.
    app.releaseSingleInstanceLock();
    relaunching = true;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' });
    ps.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true });
        setTimeout(() => app.quit(), 150);
      } else {
        // The UAC prompt was declined: stay in the current mode.
        relaunching = false;
        app.requestSingleInstanceLock();
        resolve({ ok: false });
      }
    });
    ps.on('error', () => {
      app.requestSingleInstanceLock();
      resolve({ ok: false });
    });
  });
}

// The installer sets the driver up. This covers a driver that was removed later.
function installSensorDriver() {
  const setup = isDev
    ? path.join(__dirname, '..', 'build', 'drivers', 'PawnIO_setup.exe')
    : path.join(process.resourcesPath, 'drivers', 'PawnIO_setup.exe');
  const command = `$p = Start-Process -FilePath '${setup.replace(/'/g, "''")}' -ArgumentList '-install','-silent' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' });
    ps.on('exit', (code) => resolve({ ok: code === 0, code }));
    ps.on('error', () => resolve({ ok: false, code: -1 }));
  });
}

// ---- app updates ----
// New versions come from this project's GitHub releases. The download is checked against
// the hash in the release's latest.yml before anything runs.
let updater = null;
let offeredVersion = null;

const updateLog = (level, message) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `${new Date().toISOString()} ${level} ${message}\n`);
  } catch {}
};

// Remembers which version an update was going to, so the next launch can tell if it arrived.
const attemptPath = () => path.join(app.getPath('userData'), 'update-attempt.json');

function lastAttemptFailed(offered) {
  try {
    const { version } = JSON.parse(fs.readFileSync(attemptPath(), 'utf8'));
    if (version === offered && version !== app.getVersion()) return true;
    if (version === app.getVersion()) fs.unlinkSync(attemptPath());
  } catch {}
  return false;
}

function getUpdater() {
  if (!app.isPackaged) return null;
  if (!updater) {
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.logger = {
      info: (m) => updateLog('info', m),
      warn: (m) => updateLog('warn', m),
      error: (m) => updateLog('error', m),
      debug: () => {},
    };
    updater.on('error', (e) => updateLog('error', e?.stack ?? e));
    updater.on('download-progress', (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('helper-event', 'updateProgress', { percent: Math.round(p.percent) });
    });
  }
  return updater;
}

async function checkForUpdate() {
  const current = app.getVersion();
  const u = getUpdater();
  if (!u) return { supported: false, available: false, current, version: null, size: null, page: null };
  const r = await u.checkForUpdates();
  const version = r?.updateInfo?.version ?? null;
  offeredVersion = version;
  return {
    supported: true,
    available: !!r?.isUpdateAvailable,
    current,
    version,
    size: r?.updateInfo?.files?.[0]?.size ?? null,
    page: version ? `https://github.com/Manvex/G-Ultra/releases/tag/v${version}` : null,
    lastAttemptFailed: lastAttemptFailed(version),
  };
}

async function installUpdate() {
  const u = getUpdater();
  if (!u) throw new Error('Updates only work in the installed app.');
  await u.downloadUpdate();
  try {
    fs.writeFileSync(attemptPath(), JSON.stringify({ version: offeredVersion }));
  } catch {}
  // Stopping the helper also hands the fans back to automatic.
  await helper.stopAndWait(4000);
  relaunching = true;

  // Success ends this process, so the promise only ever settles if the installer didn't take over.
  return new Promise((_resolve, reject) => {
    let timer = 0;
    const fail = (e) => {
      clearTimeout(timer);
      updater.removeListener('error', fail);
      relaunching = false;
      helper.resume();
      updateLog('error', `install didn't start: ${e?.message ?? e}`);
      reject(new Error('install-failed'));
    };
    updater.once('error', fail);
    timer = setTimeout(() => fail(new Error('still running after starting the installer')), 20000);
    u.quitAndInstall(false, false);
  });
}

app.setAppUserModelId('com.gultra.app');

const gotLock = SHOT_DIR ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    helper = new Helper(() => win);

    ipcMain.handle('rpc', (_e, method, params) => {
      if (!ALLOWED.has(method)) throw new Error('Method not allowed.');
      return helper.call(method, params);
    });
    ipcMain.handle('window', (_e, action) => {
      if (!win) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
      else if (action === 'close') win.close();
    });
    ipcMain.handle('elevate', () => relaunchElevated());
    ipcMain.handle('installDriver', () => installSensorDriver());
    ipcMain.handle('pickFolder', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Choose where to save recovered files', properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    });
    ipcMain.handle('updateCheck', () => checkForUpdate());
    ipcMain.handle('updateInstall', () => installUpdate());
    ipcMain.handle('reveal', (_e, p) => {
      if (typeof p === 'string') shell.showItemInFolder(p);
    });
    ipcMain.handle('trash', async (_e, p) => {
      if (typeof p !== 'string') throw new Error('Invalid path.');
      await shell.trashItem(p);
      return true;
    });
    ipcMain.handle('openLink', (_e, url) => {
      if (typeof url === 'string' && /^(https:|ms-settings:)/.test(url)) return shell.openExternal(url);
    });
    // Taskbar progress while work runs in the background: 2 = indeterminate, -1 = off.
    ipcMain.handle('setProgress', (_e, value) => {
      if (win && !win.isDestroyed() && typeof value === 'number') win.setProgressBar(value);
    });
    // Tells the user a job finished, only when they are busy in another window.
    ipcMain.handle('notify', (_e, title, body) => {
      if (win && !win.isDestroyed() && !win.isFocused() && Notification.isSupported()) {
        const n = new Notification({ title: String(title), body: String(body) });
        n.on('click', () => {
          if (win.isMinimized()) win.restore();
          win.focus();
        });
        n.show();
      }
    });
    ipcMain.handle('fileIcon', async (_e, p) => {
      if (typeof p !== 'string') return null;
      if (iconCache.has(p)) return iconCache.get(p);
      try {
        const img = await app.getFileIcon(p, { size: 'large' });
        const url = img.isEmpty() ? null : img.toDataURL();
        iconCache.set(p, url);
        return url;
      } catch {
        iconCache.set(p, null);
        return null;
      }
    });

    createWindow();
  });

  app.on('window-all-closed', () => {
    helper?.stop();
    startBackgroundMonitor();
    app.quit();
  });
}

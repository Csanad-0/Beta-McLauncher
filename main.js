const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Auth } = require('msmc');
const launcher = require('./launcher');
const java = require('./java');
const { listLoaderVersions, LOADERS } = require('./loaders');
const skins = require('./skins');
const { getBuffer } = require('./net');

const DATA_DIR = app.getPath('userData');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ACCOUNT_FILE = path.join(DATA_DIR, 'account.dat');
const SKINS_DIR = path.join(DATA_DIR, 'skins');
const DEFAULT_SETTINGS = {
  username: 'Player',
  version: '1.20.1',
  showSnapshots: false,
  memoryMax: 4,
  memoryMin: 2,
  javaPath: '',
  loader: 'vanilla',
  loaderVersion: '',
  skinPath: '',
  skinModel: 'classic',
  applyOfflineSkin: true,
  gameDir: path.join(DATA_DIR, 'minecraft')
};

let mainWindow = null;
let msAccount = null; // { token: msmc Minecraft, profile }

// ---------- persistence ----------
function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ...fallback };
  }
}

function loadSettings() {
  return readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
}

function saveSettings(settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const merged = { ...loadSettings(), ...settings };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

function saveRefreshToken(refreshToken) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = safeStorage.isEncryptionAvailable()
    ? Buffer.concat([Buffer.from('ENC:'), safeStorage.encryptString(refreshToken)])
    : Buffer.from('RAW:' + refreshToken);
  fs.writeFileSync(ACCOUNT_FILE, payload);
}

function loadRefreshToken() {
  try {
    const buf = fs.readFileSync(ACCOUNT_FILE);
    const tag = buf.subarray(0, 4).toString();
    const body = buf.subarray(4);
    if (tag === 'ENC:') return safeStorage.decryptString(body);
    if (tag === 'RAW:') return body.toString();
  } catch {}
  return null;
}

function clearAccount() {
  msAccount = null;
  fs.rmSync(ACCOUNT_FILE, { force: true });
}

function publicAccount() {
  if (!msAccount) return null;
  return { type: 'microsoft', name: msAccount.profile.name, uuid: msAccount.profile.id };
}

async function setAccountFromXbox(xbox) {
  const token = await xbox.getMinecraft();
  if (!token.profile) throw new Error('This Microsoft account does not own Minecraft: Java Edition.');
  msAccount = { token, profile: token.profile };
  saveRefreshToken(xbox.save());
  return publicAccount();
}

async function restoreAccount() {
  const refreshToken = loadRefreshToken();
  if (!refreshToken) return;
  try {
    const xbox = await new Auth('select_account').refresh(refreshToken);
    await setAccountFromXbox(xbox);
  } catch (err) {
    console.warn('[auth] Could not restore Microsoft session:', err?.message || err);
    clearAccount();
  }
}

// ---------- skins ----------
// Mirrors Minecraft's legacy (64x32) to modern (64x64) skin conversion.
const LEGACY_RECTS = [
  [4, 16, 16, 32, 4, 4], [8, 16, 16, 32, 4, 4], [0, 20, 24, 32, 4, 12], [4, 20, 16, 32, 4, 12],
  [8, 20, 8, 32, 4, 12], [12, 20, 16, 32, 4, 12], [44, 16, -8, 32, 4, 4], [48, 16, -8, 32, 4, 4],
  [40, 20, 0, 32, 4, 12], [44, 20, -8, 32, 4, 12], [48, 20, -16, 32, 4, 12], [52, 20, -8, 32, 4, 12]
];

// Legacy 64x32 skins often fill the hat layer with opaque pixels; Minecraft ignores it in that case.
function clearOpaqueHat(bitmap) {
  for (let y = 0; y < 16; y++) {
    for (let x = 32; x < 64; x++) {
      if (bitmap[(y * 64 + x) * 4 + 3] < 128) return;
    }
  }
  for (let y = 0; y < 16; y++) bitmap.fill(0, (y * 64 + 32) * 4, (y * 64 + 64) * 4);
}

function normalizeSkin(buffer) {
  const { height } = skins.validateSkin(buffer);
  if (height === 64) return buffer;
  const src = nativeImage.createFromBuffer(buffer).toBitmap();
  const out = Buffer.alloc(64 * 64 * 4);
  src.copy(out, 0, 0, 64 * 32 * 4);
  clearOpaqueHat(out);
  for (const [x, y, dx, dy, w, h] of LEGACY_RECTS) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const from = ((y + j) * 64 + (x + i)) * 4;
        const to = ((y + dy + j) * 64 + (x + dx + (w - 1 - i))) * 4;
        src.copy(out, to, from, from + 4);
      }
    }
  }
  return nativeImage.createFromBitmap(out, { width: 64, height: 64 }).toPNG();
}

function skinState() {
  const s = loadSettings();
  let dataUrl = null;
  if (s.skinPath && fs.existsSync(s.skinPath)) {
    try { dataUrl = skins.readSkin(s.skinPath); } catch {}
  }
  return { custom: Boolean(dataUrl), dataUrl, model: s.skinModel, applyOfflineSkin: s.applyOfflineSkin };
}

function storeSkin(buffer, model) {
  const saved = skins.saveSkin(SKINS_DIR, normalizeSkin(buffer));
  saveSettings({ skinPath: saved.path, ...(model && { skinModel: model }) });
  return skinState();
}

const skinResult = async (fn) => {
  try {
    return { ok: true, skin: await fn() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
};

function registerSkinIpc() {
  ipcMain.handle('skin:get', async () => {
    const state = skinState();
    if (!state.custom && msAccount) {
      const active = msAccount.profile.skins?.find((sk) => sk.state === 'ACTIVE');
      if (active?.url) {
        try {
          const buffer = await getBuffer(active.url.replace(/^http:/, 'https:'));
          state.dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
          state.model = active.variant === 'SLIM' ? 'slim' : 'classic';
          state.fromAccount = true;
        } catch {}
      }
    }
    return state;
  });

  ipcMain.handle('skin:pick-file', () => skinResult(async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a skin',
      filters: [{ name: 'PNG skin', extensions: ['png'] }],
      properties: ['openFile']
    });
    if (canceled || !filePaths[0]) return null;
    return storeSkin(fs.readFileSync(filePaths[0]));
  }));

  ipcMain.handle('skin:from-url', (_e, url) => skinResult(async () => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) throw new Error('Enter a valid http(s) URL.');
    return storeSkin(await getBuffer(url.trim()));
  }));

  ipcMain.handle('skin:from-player', (_e, name) => skinResult(async () => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name.trim())) throw new Error('Enter a valid username.');
    const imported = await skins.importFromUsername(SKINS_DIR, name.trim());
    return storeSkin(fs.readFileSync(imported.path), imported.model);
  }));

  ipcMain.handle('skin:set-options', (_e, { model, applyOfflineSkin }) => {
    const patch = {};
    if (model === 'classic' || model === 'slim') patch.skinModel = model;
    if (typeof applyOfflineSkin === 'boolean') patch.applyOfflineSkin = applyOfflineSkin;
    saveSettings(patch);
    return skinState();
  });

  ipcMain.handle('skin:clear', () => {
    saveSettings({ skinPath: '' });
    return skinState();
  });

  ipcMain.handle('skin:upload-account', () => skinResult(async () => {
    if (!msAccount) throw new Error('Sign in with Microsoft first.');
    const s = loadSettings();
    if (!s.skinPath || !fs.existsSync(s.skinPath)) throw new Error('Select a skin first.');
    if (!msAccount.token.validate()) await msAccount.token.refresh(true);
    await skins.uploadToAccount(msAccount.token.mcToken, s.skinPath, s.skinModel);
    return skinState();
  }));
}

// ---------- window ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Minecraft Launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, settings) => saveSettings(settings));

  ipcMain.handle('versions:list', async (_e, { showSnapshots } = {}) => launcher.fetchVersions(showSnapshots));

  ipcMain.handle('loaders:list', async (_e, { loader, version }) => {
    if (!LOADERS.includes(loader)) return { ok: false, error: `Unknown loader ${loader}` };
    try {
      return { ok: true, versions: await listLoaderVersions(loader, version) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('java:detect', async () => {
    try {
      return { ok: true, javas: await java.detectJavas(loadSettings().gameDir) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  registerSkinIpc();

  ipcMain.handle('auth:status', () => publicAccount());

  ipcMain.handle('auth:microsoft', async () => {
    try {
      const authManager = new Auth('select_account');
      const xbox = await authManager.launch('electron', {
        width: 500,
        height: 650,
        resizable: false,
        parent: mainWindow,
        modal: true,
        title: 'Sign in with Microsoft'
      });
      return { ok: true, account: await setAccountFromXbox(xbox) };
    } catch (err) {
      const message = typeof err === 'string' ? err : err?.message || String(err);
      return { ok: false, error: message === 'error.gui.closed' ? 'Login window was closed.' : message };
    }
  });

  ipcMain.handle('auth:logout', () => {
    clearAccount();
    return true;
  });

  ipcMain.handle('game:launch', async (_e, options) => {
    if (launcher.isRunning()) return { ok: false, error: 'The game is already running.' };
    const settings = saveSettings(options);

    let authorization;
    if (options.accountType === 'microsoft') {
      if (!msAccount) return { ok: false, error: 'Not signed in with Microsoft.' };
      try {
        if (!msAccount.token.validate()) await msAccount.token.refresh(true);
      } catch (err) {
        return { ok: false, error: 'Microsoft session expired, please sign in again.' };
      }
      authorization = msAccount.token.mclc();
    }

    launcher
      .launchGame({ ...settings, authorization }, send)
      .catch((err) => {
        send('launcher:log', { level: 'error', message: err?.stack || String(err) });
        send('launcher:status', { state: 'error', message: err?.message || String(err) });
      });
    return { ok: true };
  });

  ipcMain.handle('game:kill', () => launcher.kill());
  ipcMain.handle('app:open-mods-dir', (_e, { loader, version }) => {
    if (!LOADERS.includes(loader) || loader === 'vanilla' || typeof version !== 'string') return 'Invalid selection';
    const dir = path.join(launcher.instanceDir(loadSettings().gameDir, loader, version), loader === 'optifine' ? 'shaderpacks' : 'mods');
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  ipcMain.handle('app:open-game-dir', () => {
    const dir = loadSettings().gameDir;
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  await restoreAccount();
  send('auth:changed', publicAccount());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

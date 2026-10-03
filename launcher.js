const { Client, Authenticator } = require('minecraft-launcher-core');
const path = require('path');
const fs = require('fs');
const { prepareLoader } = require('./loaders');
const skins = require('./skins');
const java = require('./java');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const STAGE_LABELS = {
  assets: 'Downloading assets',
  'assets-copy': 'Copying legacy assets',
  natives: 'Downloading natives',
  classes: 'Downloading libraries',
  'classes-custom': 'Downloading custom libraries',
  'classes-maven-custom': 'Downloading Maven libraries',
  forge: 'Installing Forge'
};
const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', optifine: 'OptiFine' };
// Mojang's recommended G1 tuning plus flags that avoid native Java2D/DirectDraw crashes on Windows.
const STABILITY_JVM_ARGS = [
  '-XX:+UseG1GC',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:G1NewSizePercent=20',
  '-XX:G1ReservePercent=20',
  '-XX:MaxGCPauseMillis=50',
  '-XX:G1HeapRegionSize=32M',
  '-Dsun.java2d.noddraw=true',
  '-Dsun.java2d.d3d=false',
  '-Dfile.encoding=UTF-8'
];
// 0xC0000005 (EXCEPTION_ACCESS_VIOLATION) as reported by Windows, both unsigned and signed.
const ACCESS_VIOLATION_CODES = [3221225477, -1073741819];

/** Modded profiles get their own instance folder so mods/configs don't clash. */
function instanceDir(root, loader, versionId) {
  if (!loader || loader === 'vanilla') return root;
  return path.join(root, 'instances', `${loader}-${versionId}`);
}

let manifestCache = null;
let current = null; // { client, process }

async function getManifest() {
  if (manifestCache) return manifestCache;
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`Version manifest request failed (${res.status})`);
  manifestCache = await res.json();
  return manifestCache;
}

async function fetchVersions(showSnapshots = false) {
  try {
    const manifest = await getManifest();
    return {
      latest: manifest.latest,
      versions: manifest.versions
        .filter((v) => v.type === 'release' || (showSnapshots && v.type === 'snapshot'))
        .map((v) => ({ id: v.id, type: v.type }))
    };
  } catch (err) {
    return { offline: true, error: err.message, versions: [{ id: '1.20.1', type: 'release' }] };
  }
}

/** Resolves a version against Mojang's manifest: its real type and the Java it needs. */
async function resolveVersion(versionId, gameDir) {
  const local = path.join(gameDir, 'versions', versionId, `${versionId}.json`);
  let json = null;
  try { json = JSON.parse(fs.readFileSync(local, 'utf8')); } catch {}

  let entry = null;
  try {
    entry = (await getManifest()).versions.find((v) => v.id === versionId) || null;
    if (!entry && !json) return { error: `Unknown Minecraft version "${versionId}"` };
    if (!json && entry) json = await (await fetch(entry.url)).json();
  } catch {
    if (!json) return { error: `Could not load metadata for ${versionId} (offline?)` };
  }
  return {
    type: entry?.type || json?.type || 'release',
    javaMajor: json?.javaVersion?.majorVersion ?? 8,
    javaComponent: json?.javaVersion?.component
  };
}

/** Explains well-known crash exit codes and points to the JVM crash report. */
function diagnoseCrash(code, gameDirectory, javaInfo, log) {
  if (ACCESS_VIOLATION_CODES.includes(code)) {
    log('Exit code 0xC0000005 (access violation): a native component (graphics driver, LWJGL or the JVM) crashed.', 'error');
    log(`It ran on ${javaInfo}. Update your GPU drivers, remove overlays (Discord, RivaTuner, OBS hooks) and try Vanilla to rule out mods.`, 'error');
  }
  try {
    const reports = fs.readdirSync(gameDirectory)
      .filter((f) => /^hs_err_pid\d+\.log$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(gameDirectory, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (reports[0] && Date.now() - reports[0].t < 10 * 60 * 1000) {
      const file = path.join(gameDirectory, reports[0].f);
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const i = lines.findIndex((l) => l.includes('Problematic frame'));
      const problem = i >= 0 ? lines[i + 1] : null;
      log(`JVM crash report: ${file}`, 'error');
      if (problem) log(problem.replace(/^#\s*/, ''), 'error');
    }
  } catch {}
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

/**
 * Downloads (if needed) and launches Minecraft, streaming state to the UI.
 * @param {object} opts settings + optional msmc `authorization`
 * @param {(channel: string, payload: any) => void} send IPC emitter
 */
async function launchGame(opts, send) {
  const log = (message, level = 'info') => send('launcher:log', { level, message, time: Date.now() });
  const status = (state, message) => send('launcher:status', { state, message });

  const versionId = opts.version || '1.20.1';
  const gameDir = opts.gameDir;
  fs.mkdirSync(gameDir, { recursive: true });

  // ---- Version ----
  status('java', 'Checking version and Java...');
  const versionInfo = await resolveVersion(versionId, gameDir);
  if (versionInfo.error) {
    log(versionInfo.error, 'error');
    status('error', 'Invalid version');
    return;
  }

  // ---- Java ----
  const sendDownload = (() => {
    let last = 0;
    return ({ name, current: cur, total }) => {
      const now = Date.now();
      if (now - last < 250 && cur < total) return;
      last = now;
      send('launcher:download', { name, current: cur, total, speed: '' });
    };
  })();
  let runtime;
  try {
    runtime = await java.resolveJava({
      customPath: opts.javaPath?.trim(),
      required: versionInfo.javaMajor,
      component: versionInfo.javaComponent,
      root: gameDir,
      log,
      onDownload: (d) => {
        status('downloading', 'Downloading Java runtime');
        sendDownload(d);
        send('launcher:progress', { type: 'java', label: 'Downloading Java runtime', task: d.current, total: d.total, percent: Math.round((d.current / d.total) * 100) });
      }
    });
  } catch (err) {
    log(`Java setup failed: ${err.message}. Install Java ${versionInfo.javaMajor} (64-bit) or set a Java path in Settings.`, 'error');
    status('error', `Java ${versionInfo.javaMajor} required`);
    return;
  }
  const javaPath = java.launchExecutable(runtime.path);
  const javaInfo = `Java ${runtime.version} (${runtime.vendor || 'unknown vendor'}, 64-bit)`;
  log(`Using ${javaInfo} - ${runtime.path} (Minecraft ${versionId} requires Java ${versionInfo.javaMajor})`);

  // ---- Auth ----
  let authorization = opts.authorization;
  if (!authorization) {
    const username = (opts.username || 'Player').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
      log('Username must be 3-16 characters: letters, numbers and underscores.', 'error');
      status('error', 'Invalid username');
      return;
    }
    authorization = await Authenticator.getAuth(username);
    log(`Using offline account "${username}"`);
  } else {
    log(`Using Microsoft account "${authorization.name}"`);
  }

  // ---- Mod loader ----
  const loader = opts.loader || 'vanilla';
  const gameDirectory = instanceDir(gameDir, loader, versionId);
  fs.mkdirSync(gameDirectory, { recursive: true });
  let loaderOpts = {};
  if (loader !== 'vanilla') {
    status('installing', `Preparing ${LOADER_NAMES[loader]}${opts.loaderLabel ? ` ${opts.loaderLabel}` : ''}...`);
    try {
      loaderOpts = await prepareLoader({
        loader,
        loaderVersion: opts.loaderVersion,
        mc: versionId,
        root: gameDir,
        javaPath,
        log,
        onDownload: sendDownload
      });
    } catch (err) {
      log(`${LOADER_NAMES[loader]} setup failed: ${err.message}`, 'error');
      status('error', `${LOADER_NAMES[loader]} setup failed`);
      return;
    }
    log(`Instance folder: ${gameDirectory}`);
  }

  // ---- Offline skin ----
  try {
    if (!opts.authorization && opts.applyOfflineSkin && opts.skinPath && fs.existsSync(opts.skinPath)) {
      skins.applyOfflineSkin(gameDirectory, opts.skinPath, versionId);
      log('Applied custom skin via resource pack "BlockLauncherSkin"');
    } else {
      skins.removeOfflineSkin(gameDirectory);
    }
  } catch (err) {
    log(`Could not apply offline skin: ${err.message}`, 'warn');
  }

  // ---- Launch ----
  const client = new Client();
  current = { client, process: null };

  const speed = { bytes: 0, last: Date.now(), lastSent: 0 };
  const lastByFile = new Map();

  client.on('debug', (msg) => log(String(msg).trim(), 'debug'));
  client.on('data', (msg) => {
    String(msg).split(/\r?\n/).filter(Boolean).forEach((line) => log(line, 'game'));
  });

  let lastStage = null;
  let lastPercent = -1;
  client.on('progress', ({ type, task, total }) => {
    const label = STAGE_LABELS[type] || `Downloading ${type}`;
    if (type !== lastStage) {
      lastStage = type;
      lastPercent = -1;
      status('downloading', label);
    }
    const percent = total ? Math.round((task / total) * 100) : 0;
    if (percent === lastPercent) return;
    lastPercent = percent;
    send('launcher:progress', { type, label, task, total, percent });
  });

  // MCLC's per-chunk download event; used to derive a transfer speed.
  client.on('download-status', ({ name, type, current: cur, total }) => {
    const prev = lastByFile.get(name) || 0;
    speed.bytes += Math.max(cur - prev, 0);
    if (cur >= total) lastByFile.delete(name);
    else lastByFile.set(name, cur);

    const now = Date.now();
    if (now - speed.lastSent < 250) return;
    const elapsed = (now - speed.last) / 1000;
    const bps = elapsed > 0 ? speed.bytes / elapsed : 0;
    speed.bytes = 0;
    speed.last = now;
    speed.lastSent = now;
    send('launcher:download', { name, type, current: cur, total, speed: `${formatBytes(bps)}/s` });
  });

  client.on('download', (name) => log(`Downloaded ${name}`, 'debug'));
  client.on('package-extract', () => {
    log('Client package extracted');
    status('extracting', 'Extracted client package');
  });
  client.on('arguments', () => status('launching', 'Launching Minecraft...'));

  client.on('close', (code) => {
    const stopped = current?.stopped;
    const ok = code === 0 || stopped;
    log(stopped ? 'Minecraft was stopped by the launcher' : `Minecraft exited with code ${code}`, ok ? 'info' : 'error');
    if (!ok) diagnoseCrash(code, gameDirectory, javaInfo, log);
    send('launcher:closed', { code, stopped: Boolean(stopped) });
    status('idle', stopped ? 'Game stopped' : code === 0 ? 'Game closed' : `Game crashed (exit code ${code})`);
    current = null;
  });

  status('preparing', `Preparing Minecraft ${versionId}...`);
  log(`Launching ${versionId} in ${gameDir}`);

  const memoryMax = Math.max(1, Number(opts.memoryMax) || 4);
  const memoryMin = Math.min(memoryMax, Math.max(1, Number(opts.memoryMin) || 2));
  const child = await client.launch({
    authorization,
    root: gameDir,
    version: { number: versionId, type: versionInfo.type, ...(loaderOpts.custom && { custom: loaderOpts.custom }) },
    ...(loaderOpts.forge && { forge: loaderOpts.forge }),
    memory: { max: `${memoryMax}G`, min: `${memoryMin}G` },
    javaPath,
    customArgs: STABILITY_JVM_ARGS,
    overrides: { detached: false, gameDirectory }
  });

  if (!child) {
    current = null;
    status('error', 'Launch failed - see logs');
    return;
  }
  if (current) current.process = child;
  status('running', `${loader === 'vanilla' ? 'Minecraft' : LOADER_NAMES[loader]} ${versionId} is running`);
  send('launcher:progress', { type: 'done', label: 'Running', task: 1, total: 1, percent: 100 });
}

function isRunning() {
  return current !== null;
}

function kill() {
  if (current?.process && !current.process.killed) {
    current.stopped = true;
    current.process.kill();
    return true;
  }
  return false;
}

module.exports = { launchGame, fetchVersions, isRunning, kill, instanceDir };

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getJson, downloadFile } = require('./net');

const RUNTIME_INDEX =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const COMPONENT_BY_MAJOR = { 8: 'jre-legacy', 16: 'java-runtime-alpha', 17: 'java-runtime-gamma', 21: 'java-runtime-delta' };
const IS_WIN = process.platform === 'win32';
const JAVA_EXE = IS_WIN ? 'java.exe' : 'java';

const probeCache = new Map();

/** Highest Java major a Minecraft version is known to run on reliably. */
function maxSupportedJava(required) {
  if (required <= 8) return 8;
  if (required < 21) return 21;
  return 25;
}

function isCompatible(java, required) {
  return java.ok && java.is64Bit && !java.earlyAccess && java.major >= required && java.major <= maxSupportedJava(required);
}

/** Runs `java -XshowSettings:properties -version` and parses the JVM properties. */
function probeJava(javaPath) {
  const exe = IS_WIN ? javaPath.replace(/javaw\.exe$/i, 'java.exe') : javaPath;
  if (probeCache.has(exe)) return probeCache.get(exe);
  const result = new Promise((resolve) => {
    execFile(exe, ['-XshowSettings:properties', '-version'], { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stderr}${stdout}`;
      const prop = (name) => out.match(new RegExp(`^\\s*${name.replace('.', '\\.')} = (.*)$`, 'm'))?.[1]?.trim();
      const version = prop('java.version') || out.match(/version "([^"]+)"/)?.[1];
      if (!version) {
        const error = err?.code === 'ENOENT' ? 'executable not found' : (err?.message || 'not a Java executable').split('\n')[0];
        return resolve({ ok: false, path: javaPath, error });
      }
      const parts = version.split(/[._+-]/).map(Number);
      const major = parts[0] === 1 ? parts[1] : parts[0];
      const home = prop('java.home');
      const homeExe = home && path.join(home, 'bin', JAVA_EXE);
      resolve({
        ok: true,
        path: homeExe && fs.existsSync(homeExe) ? homeExe : javaPath,
        version,
        major,
        vendor: prop('java.vendor') || '',
        is64Bit: prop('sun.arch.data.model') ? prop('sun.arch.data.model') === '64' : /64-Bit/.test(out),
        earlyAccess: /-ea\b|internal/i.test(prop('java.runtime.version') || version)
      });
    });
  });
  probeCache.set(exe, result);
  return result;
}

function globBin(parents, depthDirs = ['bin'], exe = JAVA_EXE) {
  const found = [];
  for (const parent of parents) {
    let entries = [];
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = path.join(parent, entry.name, ...depthDirs, exe);
      if (fs.existsSync(file)) found.push(file);
    }
  }
  return found;
}

/** Minecraft-launcher style runtime folders: <runtime>/<component>/<platform>/<component>/bin/java */
function mojangRuntimes(runtimeDir) {
  const found = [];
  let components = [];
  try { components = fs.readdirSync(runtimeDir); } catch { return found; }
  for (const comp of components) {
    const base = path.join(runtimeDir, comp);
    found.push(...[path.join(base, 'bin', JAVA_EXE), path.join(base, 'jre.bundle', 'Contents', 'Home', 'bin', JAVA_EXE)]);
    found.push(...globBin([base], [comp, 'bin']), ...globBin([base], [comp, 'jre.bundle', 'Contents', 'Home', 'bin']));
  }
  return found.filter((f) => fs.existsSync(f));
}

function candidatePaths(root) {
  const list = ['java'];
  if (process.env.JAVA_HOME) list.push(path.join(process.env.JAVA_HOME, 'bin', JAVA_EXE));
  list.push(...mojangRuntimes(path.join(root, 'runtime')));
  const home = os.homedir();

  if (IS_WIN) {
    const programDirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean);
    const vendors = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'OpenJDK'];
    list.push(...globBin(programDirs.flatMap((p) => vendors.map((v) => path.join(p, v)))));
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    list.push(...mojangRuntimes(path.join(local, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime')));
    list.push(...programDirs.flatMap((p) => mojangRuntimes(path.join(p, 'Minecraft Launcher', 'runtime'))));
    list.push(...mojangRuntimes(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.minecraft', 'runtime')));
  } else if (process.platform === 'darwin') {
    list.push(...globBin(['/Library/Java/JavaVirtualMachines', path.join(home, 'Library/Java/JavaVirtualMachines')], ['Contents', 'Home', 'bin']));
    list.push(...globBin(['/opt/homebrew/opt', '/usr/local/opt']).filter((p) => /openjdk/.test(p)));
    list.push(...mojangRuntimes(path.join(home, 'Library/Application Support/minecraft/runtime')));
  } else {
    list.push(...globBin(['/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk', path.join(home, '.sdkman/candidates/java'), path.join(home, '.jdks')]));
    list.push(...mojangRuntimes(path.join(home, '.minecraft', 'runtime')));
  }
  return [...new Set(list)];
}

/** All working Java installations, deduplicated by their real path. */
async function detectJavas(root) {
  const probes = await Promise.all(candidatePaths(root).map(probeJava));
  const byPath = new Map();
  for (const p of probes) {
    if (!p.ok) continue;
    const key = (() => { try { return fs.realpathSync(p.path); } catch { return p.path; } })();
    if (!byPath.has(key)) byPath.set(key, p);
  }
  return [...byPath.values()].sort((a, b) => b.major - a.major);
}

function runtimePlatform() {
  const arm = process.arch === 'arm64';
  if (IS_WIN) return arm ? 'windows-arm64' : process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return arm ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'ia32' ? 'linux-i386' : 'linux';
}

function runtimeExecutable(dir) {
  if (process.platform === 'darwin') return path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join(dir, 'bin', JAVA_EXE);
}

const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

/** Downloads Mojang's official Java runtime (same one the vanilla launcher uses). */
async function installRuntime({ component, root, log, onDownload }) {
  const platform = runtimePlatform();
  const index = await getJson(RUNTIME_INDEX);
  const entry = index[platform]?.[component]?.[0];
  if (!entry) throw new Error(`Mojang provides no ${component} runtime for ${platform}`);

  const dir = path.join(root, 'runtime', component);
  const marker = path.join(dir, '.installed');
  const exe = runtimeExecutable(dir);
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === entry.manifest.sha1 && fs.existsSync(exe)) return exe;

  log(`Downloading Java runtime ${entry.version.name} (${component})...`);
  const { files } = await getJson(entry.manifest.url);
  const items = Object.entries(files);
  for (const [name, f] of items) if (f.type === 'directory') fs.mkdirSync(path.join(dir, name), { recursive: true });

  const downloads = items.filter(([, f]) => f.type === 'file');
  let done = 0;
  const queue = [...downloads];
  const worker = async () => {
    while (queue.length) {
      const [name, f] = queue.shift();
      const dest = path.join(dir, name);
      if (!(fs.existsSync(dest) && sha1(dest) === f.downloads.raw.sha1)) {
        await downloadFile(f.downloads.raw.url, dest);
        if (sha1(dest) !== f.downloads.raw.sha1) throw new Error(`Checksum mismatch for ${name}`);
      }
      if (f.executable && !IS_WIN) fs.chmodSync(dest, 0o755);
      onDownload?.({ name: `Java runtime (${++done}/${downloads.length})`, current: done, total: downloads.length });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  if (!IS_WIN) {
    for (const [name, f] of items) {
      if (f.type !== 'link') continue;
      const dest = path.join(dir, name);
      fs.rmSync(dest, { force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(f.target, dest);
    }
  }
  fs.writeFileSync(marker, entry.manifest.sha1);
  probeCache.delete(exe);
  return exe;
}

/**
 * Picks a Java runtime compatible with the Minecraft version:
 * custom path (if valid) -> best installed match -> Mojang runtime download.
 */
async function resolveJava({ customPath, required, component, root, log, onDownload }) {
  const describe = (j) => `Java ${j.version} (${j.vendor || 'unknown vendor'}, ${j.is64Bit ? '64' : '32'}-bit) at ${j.path}`;
  const max = maxSupportedJava(required);

  if (customPath) {
    const java = await probeJava(customPath);
    if (isCompatible(java, required)) return java;
    const reason = !java.ok ? java.error
      : !java.is64Bit ? '32-bit Java cannot allocate enough memory'
      : java.earlyAccess ? `Java ${java.version} is an early-access build`
      : `Java ${java.major} is outside the supported range ${required}-${max}`;
    log(`Custom Java path ignored: ${reason}. Falling back to automatic detection.`, 'warn');
  }

  const installed = await detectJavas(root);
  const compatible = installed.filter((j) => isCompatible(j, required));
  for (const j of installed.filter((j) => !compatible.includes(j))) {
    log(`Skipping incompatible ${describe(j)}`, 'debug');
  }
  // Prefer the exact major the version was built for, then the closest newer LTS.
  compatible.sort((a, b) => (a.major === required ? -1 : 0) - (b.major === required ? -1 : 0) || a.major - b.major);
  if (compatible[0]) return compatible[0];

  const comp = component || COMPONENT_BY_MAJOR[required] || COMPONENT_BY_MAJOR[17];
  log(`No compatible Java ${required === max ? required : `${required}-${max}`} installation found.`, 'warn');
  const exe = await installRuntime({ component: comp, root, log, onDownload });
  const java = await probeJava(exe);
  if (!java.ok) throw new Error(`Downloaded Java runtime does not start: ${java.error}`);
  return java;
}

/** On Windows launch through javaw.exe so no console window appears. */
function launchExecutable(javaPath) {
  if (!IS_WIN) return javaPath;
  const javaw = javaPath.replace(/java\.exe$/i, 'javaw.exe');
  return fs.existsSync(javaw) ? javaw : javaPath;
}

module.exports = { resolveJava, detectJavas, probeJava, launchExecutable, maxSupportedJava };

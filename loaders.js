const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getJson, getText, downloadFile } = require('./net');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const OPTIFINE_SITE = 'https://optifine.net';
const OPTIFINE_MIRROR = 'https://bmclapi2.bangbang93.com/optifine';
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

const LOADERS = ['vanilla', 'fabric', 'forge', 'optifine'];
const cache = new Map();

async function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((err) => { cache.delete(key); throw err; }));
  return cache.get(key);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compareNumeric = (a, b) => {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
};

// ---------------- version lists ----------------

async function listFabric(mc) {
  const list = await getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}`);
  return list.map(({ loader }) => ({
    id: loader.version,
    label: `${loader.version}${loader.stable ? '' : ' (beta)'}`,
    recommended: loader.stable
  }));
}

async function listForge(mc) {
  const [xml, promos] = await Promise.all([
    cached('forge-meta', () => getText(`${FORGE_MAVEN}/maven-metadata.xml`)),
    cached('forge-promos', () => getJson(FORGE_PROMOS)).catch(() => ({ promos: {} }))
  ]);
  const recommended = promos.promos?.[`${mc}-recommended`];
  const latest = promos.promos?.[`${mc}-latest`];
  const prefix = `${mc}-`;
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1])
    .filter((v) => v.startsWith(prefix))
    .map((full) => ({ full, build: full.slice(prefix.length) }))
    .sort((a, b) => compareNumeric(a.build, b.build))
    .map(({ full, build }) => {
      const short = build.replace(new RegExp(`-${escapeRe(mc)}$`), '');
      const tag = short === recommended ? ' (recommended)' : short === latest ? ' (latest)' : '';
      return { id: full, label: `${short}${tag}`, recommended: short === recommended };
    });
}

async function listOptiFine(mc) {
  try {
    const html = await cached('optifine-downloads', () => getText(`${OPTIFINE_SITE}/downloads`));
    const re = new RegExp(`adloadx\\?f=(OptiFine_${escapeRe(mc)}_[A-Za-z0-9_]+\\.jar)`, 'g');
    const files = [...new Set([...html.matchAll(re)].map((m) => m[1]))];
    if (files.length) {
      return files.map((file, i) => ({ id: file, label: optiFineLabel(file, mc), recommended: i === 0 }));
    }
  } catch {}
  // Fallback: BMCLAPI mirror (used by HMCL/PCL) when optifine.net is unreachable.
  const list = await getJson(`${OPTIFINE_MIRROR}/${encodeURIComponent(mc)}`);
  return list
    .filter((v) => !v.filename.startsWith('preview_'))
    .reverse()
    .map((v, i) => ({ id: v.filename, label: optiFineLabel(v.filename, mc), recommended: i === 0 }));
}

function optiFineLabel(file, mc) {
  return file.replace(/^OptiFine_/, '').replace(`${mc}_`, '').replace(/\.jar$/, '').replace(/_/g, ' ');
}

async function listLoaderVersions(loader, mc) {
  if (!mc || loader === 'vanilla') return [];
  const fn = { fabric: listFabric, forge: listForge, optifine: listOptiFine }[loader];
  if (!fn) throw new Error(`Unknown loader: ${loader}`);
  return cached(`${loader}:${mc}`, () => fn(mc));
}

// ---------------- installation ----------------

/**
 * Makes sure the selected loader is installed under `root` and returns
 * the extra MCLC options needed to launch it.
 */
async function prepareLoader({ loader, loaderVersion, mc, root, javaPath, log, onDownload }) {
  if (!loader || loader === 'vanilla') return {};
  if (!loaderVersion) throw new Error(`No ${loader} version selected.`);
  switch (loader) {
    case 'fabric': return prepareFabric(mc, loaderVersion, root, log);
    case 'forge': return prepareForge(mc, loaderVersion, root, log, onDownload);
    case 'optifine': return prepareOptiFine(mc, loaderVersion, root, javaPath, log, onDownload);
    default: throw new Error(`Unknown loader: ${loader}`);
  }
}

async function prepareFabric(mc, loaderVersion, root, log) {
  const id = `fabric-loader-${loaderVersion}-${mc}`;
  const file = path.join(root, 'versions', id, `${id}.json`);
  if (!fs.existsSync(file)) {
    log(`Installing Fabric ${loaderVersion} for ${mc}...`);
    const profile = await getJson(
      `${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/profile/json`
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  }
  log(`Using Fabric profile ${id}`);
  return { custom: id };
}

async function prepareForge(mc, forgeVersion, root, log, onDownload) {
  const file = path.join(root, 'loaders', 'forge', `forge-${forgeVersion}-installer.jar`);
  if (!fs.existsSync(file)) {
    log(`Downloading Forge installer ${forgeVersion}...`);
    await downloadFile(`${FORGE_MAVEN}/${forgeVersion}/forge-${forgeVersion}-installer.jar`, file, onDownload);
  }
  log(`Using Forge installer ${path.basename(file)}`);
  return { forge: file };
}

async function prepareOptiFine(mc, fileName, root, javaPath, log, onDownload) {
  const edition = fileName.replace(/^OptiFine_/, '').replace(`${mc}_`, '').replace(/\.jar$/, '');
  const id = `${mc}-OptiFine_${edition}`;
  if (fs.existsSync(path.join(root, 'versions', id, `${id}.json`))) {
    log(`Using OptiFine profile ${id}`);
    return { custom: id };
  }

  log(`Installing OptiFine ${edition} for ${mc}...`);
  await ensureVanillaFiles(mc, root, log, onDownload);

  const jar = path.join(root, 'loaders', 'optifine', fileName);
  if (!fs.existsSync(jar)) await downloadOptiFine(mc, fileName, jar, log, onDownload);

  // The OptiFine installer needs a launcher_profiles.json to exist.
  const profiles = path.join(root, 'launcher_profiles.json');
  if (!fs.existsSync(profiles)) fs.writeFileSync(profiles, JSON.stringify({ profiles: {} }));

  const helper = path.join(root, 'loaders', 'optifine', 'OptiFineInstall.java');
  fs.writeFileSync(
    helper,
    'public class OptiFineInstall { public static void main(String[] a) throws Exception {' +
      ' optifine.Installer.doInstall(new java.io.File(a[0])); } }'
  );

  await new Promise((resolve, reject) => {
    execFile(
      javaPath,
      ['-Djava.awt.headless=true', '-cp', jar, helper, root],
      { timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const hint = /source-file mode|Unrecognized option|class file/i.test(stderr) ? ' (requires Java 11+)' : '';
          return reject(new Error(`OptiFine installer failed${hint}: ${(stderr || err.message).trim().split('\n').pop()}`));
        }
        resolve();
      }
    );
  });

  if (!fs.existsSync(path.join(root, 'versions', id, `${id}.json`))) {
    throw new Error(`OptiFine installer did not produce version ${id}`);
  }
  log(`OptiFine installed as ${id}`);
  return { custom: id };
}

async function downloadOptiFine(mc, fileName, dest, log, onDownload) {
  try {
    const page = await getText(`${OPTIFINE_SITE}/adloadx?f=${encodeURIComponent(fileName)}`);
    const link = page.match(/downloadx\?f=[^'"]+/);
    if (!link) throw new Error('download link not found');
    await downloadFile(`${OPTIFINE_SITE}/${link[0].replace(/&amp;/g, '&')}`, dest, onDownload);
  } catch (err) {
    log(`optifine.net download failed (${err.message}), trying mirror...`, 'warn');
    const parts = fileName.replace(/^OptiFine_/, '').replace(`${mc}_`, '').replace(/\.jar$/, '').split('_');
    const patch = parts.pop();
    const type = parts.join('_');
    await downloadFile(`${OPTIFINE_MIRROR}/${encodeURIComponent(mc)}/${type}/${patch}`, dest, onDownload);
  }
}

/** Downloads versions/<mc>/<mc>.json and .jar, which the OptiFine installer patches. */
async function ensureVanillaFiles(mc, root, log, onDownload) {
  const dir = path.join(root, 'versions', mc);
  const jsonFile = path.join(dir, `${mc}.json`);
  const jarFile = path.join(dir, `${mc}.jar`);
  let json;
  if (fs.existsSync(jsonFile)) {
    json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } else {
    const entry = (await getJson(MOJANG_MANIFEST)).versions.find((v) => v.id === mc);
    if (!entry) throw new Error(`Unknown Minecraft version ${mc}`);
    json = await getJson(entry.url);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(json, null, 2));
  }
  if (!fs.existsSync(jarFile)) {
    log(`Downloading Minecraft ${mc} client jar...`);
    await downloadFile(json.downloads.client.url, jarFile, onDownload);
  }
}

module.exports = { LOADERS, listLoaderVersions, prepareLoader };

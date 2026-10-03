const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getJson, getBuffer, request } = require('./net');

const PACK_NAME = 'BlockLauncherSkin';
const PACK_ID = `file/${PACK_NAME}`;
const DEFAULT_SKINS = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Returns { width, height } or throws if the buffer is not a valid Minecraft skin PNG. */
function validateSkin(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('File is not a PNG image.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) {
    throw new Error(`Skin must be 64x64 or 64x32 pixels (got ${width}x${height}).`);
  }
  return { width, height };
}

function saveSkin(skinsDir, buffer) {
  const { width, height } = validateSkin(buffer);
  fs.mkdirSync(skinsDir, { recursive: true });
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const file = path.join(skinsDir, `${hash}.png`);
  fs.writeFileSync(file, buffer);
  return { path: file, width, height, dataUrl: toDataUrl(buffer) };
}

const toDataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;

function readSkin(file) {
  const buffer = fs.readFileSync(file);
  validateSkin(buffer);
  return toDataUrl(buffer);
}

async function importFromUrl(skinsDir, url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  return saveSkin(skinsDir, await getBuffer(url));
}

/** Fetches the current skin of any Java Edition player by username. */
async function importFromUsername(skinsDir, username) {
  const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`);
  if (res.status === 204 || res.status === 404) throw new Error(`Player "${username}" not found.`);
  if (!res.ok) throw new Error(`Mojang API error (${res.status})`);
  const { id } = await res.json();
  const profile = await getJson(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
  const prop = profile.properties?.find((p) => p.name === 'textures');
  const textures = prop && JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')).textures;
  if (!textures?.SKIN?.url) throw new Error(`"${username}" uses a default skin.`);
  const skin = saveSkin(skinsDir, await getBuffer(textures.SKIN.url.replace(/^http:/, 'https:')));
  return { ...skin, model: textures.SKIN.metadata?.model === 'slim' ? 'slim' : 'classic' };
}

/** Uploads a skin PNG to the signed-in Microsoft account (Minecraft Services API). */
async function uploadToAccount(mcToken, file, model) {
  const buffer = fs.readFileSync(file);
  validateSkin(buffer);
  const form = new FormData();
  form.append('variant', model === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'skin.png');
  await request('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcToken}` },
    body: form
  });
}

function packFormat(mc) {
  const [, minor = 0, patch = 0] = mc.split('.').map((n) => parseInt(n, 10) || 0);
  const table = [
    [[21, 9], 69], [[21, 7], 64], [[21, 6], 63], [[21, 5], 55], [[21, 4], 46], [[21, 2], 42], [[21, 0], 34],
    [[20, 5], 32], [[20, 3], 22], [[20, 2], 18], [[20, 0], 15], [[19, 4], 13], [[19, 3], 12], [[19, 0], 9],
    [[18, 0], 8], [[17, 0], 7], [[16, 2], 6], [[15, 0], 5], [[13, 0], 4], [[11, 0], 3], [[9, 0], 2]
  ];
  if (!/^1\.\d+/.test(mc)) return 69; // snapshots / unknown: assume newest
  for (const [[mi, pa], fmt] of table) if (minor > mi || (minor === mi && patch >= pa)) return fmt;
  return 1;
}

function readOptions(gameDir) {
  const file = path.join(gameDir, 'options.txt');
  return { file, lines: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [] };
}

function updatePackList(lines, key, mutate) {
  const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
  let list = [];
  if (idx >= 0) {
    try { list = JSON.parse(lines[idx].slice(key.length + 1)); } catch {}
  } else if (key === 'resourcePacks') {
    list = ['vanilla'];
  }
  list = mutate(list.filter((p) => p !== PACK_ID));
  const line = `${key}:${JSON.stringify(list)}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
}

/**
 * Offline accounts cannot use Mojang's skin servers, so we generate a resource
 * pack that replaces every default skin texture and enable it in options.txt.
 */
function applyOfflineSkin(gameDir, skinFile, mc) {
  const buffer = fs.readFileSync(skinFile);
  validateSkin(buffer);
  const packDir = path.join(gameDir, 'resourcepacks', PACK_NAME);
  fs.rmSync(packDir, { recursive: true, force: true });
  const tex = path.join(packDir, 'assets', 'minecraft', 'textures', 'entity');
  const targets = [path.join(tex, 'steve.png'), path.join(tex, 'alex.png')];
  for (const model of ['wide', 'slim']) {
    for (const name of DEFAULT_SKINS) targets.push(path.join(tex, 'player', model, `${name}.png`));
  }
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, buffer);
  }
  const format = packFormat(mc);
  const meta = { pack: { pack_format: format, description: 'Custom offline skin (Block Launcher)' } };
  if (format >= 18) meta.pack.supported_formats = [format, 999];
  if (format >= 65) Object.assign(meta.pack, { min_format: format, max_format: 999 });
  fs.writeFileSync(path.join(packDir, 'pack.mcmeta'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(packDir, 'pack.png'), buffer);

  const { file, lines } = readOptions(gameDir);
  updatePackList(lines, 'resourcePacks', (list) => [...list, PACK_ID]);
  updatePackList(lines, 'incompatibleResourcePacks', (list) => [...list, PACK_ID]);
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(file, lines.filter((l, i) => l || i < lines.length - 1).join('\n') + '\n');
}

function removeOfflineSkin(gameDir) {
  fs.rmSync(path.join(gameDir, 'resourcepacks', PACK_NAME), { recursive: true, force: true });
  const { file, lines } = readOptions(gameDir);
  if (!lines.length) return;
  for (const key of ['resourcePacks', 'incompatibleResourcePacks']) {
    if (lines.some((l) => l.startsWith(`${key}:`))) updatePackList(lines, key, (list) => list);
  }
  fs.writeFileSync(file, lines.join('\n'));
}

module.exports = {
  validateSkin,
  saveSkin,
  readSkin,
  importFromUrl,
  importFromUsername,
  uploadToAccount,
  applyOfflineSkin,
  removeOfflineSkin,
  packFormat
};

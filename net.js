const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const USER_AGENT = 'BlockLauncher/1.0 (+electron)';

async function request(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) } });
  if (!res.ok) throw new Error(`Request to ${url} failed (${res.status})`);
  return res;
}

const getJson = async (url) => (await request(url)).json();
const getText = async (url) => (await request(url)).text();
const getBuffer = async (url) => Buffer.from(await (await request(url)).arrayBuffer());

/** Streams `url` to `dest` (atomically via a .part file), reporting progress. */
async function downloadFile(url, dest, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await request(url);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  let current = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    current += chunk.length;
    onProgress?.({ name: path.basename(dest), current, total });
  });
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = { request, getJson, getText, getBuffer, downloadFile };

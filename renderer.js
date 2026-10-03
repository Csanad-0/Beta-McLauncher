const api = window.launcherAPI;
const $ = (id) => document.getElementById(id);

const el = {
  username: $('username'),
  usernameHint: $('username-hint'),
  version: $('version'),
  loader: $('loader'),
  loaderVersion: $('loader-version'),
  openMods: $('open-mods'),
  skinHead: $('skin-head'),
  profileName: $('profile-name'),
  profileSub: $('profile-sub'),
  accountStatus: $('account-status'),
  accountDot: $('account-dot'),
  accountLabel: $('account-label'),
  navItems: document.querySelectorAll('.nav-item'),
  views: document.querySelectorAll('.view'),
  loaderCards: document.querySelectorAll('.loader-card'),
  chipVersion: $('chip-version'),
  chipLoader: $('chip-loader'),
  modsVersion: $('mods-version'),
  javaDetect: $('java-detect'),
  javaList: $('java-list'),
  logLast: $('log-last'),
  skinCanvas: $('skin-canvas'),
  skinEmpty: $('skin-empty'),
  skinAnim: $('skin-anim'),
  skinModelTabs: document.querySelectorAll('#skin-model .seg'),
  skinUpload: $('skin-upload'),
  skinUrl: $('skin-url'),
  skinUrlBtn: $('skin-url-btn'),
  skinPlayer: $('skin-player'),
  skinPlayerBtn: $('skin-player-btn'),
  skinOffline: $('skin-offline'),
  skinMsUpload: $('skin-ms-upload'),
  skinClear: $('skin-clear'),
  skinStatus: $('skin-status'),
  launch: $('launch'),
  memory: $('memory'),
  memoryValue: $('memory-value'),
  javaPath: $('java-path'),
  showSnapshots: $('show-snapshots'),
  openDir: $('open-dir'),
  statusText: $('status-text'),
  progressMeta: $('progress-meta'),
  progressBar: $('progress-bar'),
  downloadFile: $('download-file'),
  downloadSpeed: $('download-speed'),
  heroSub: $('hero-sub'),
  log: $('log'),
  logCard: $('log-card'),
  logToggle: $('log-toggle'),
  logClear: $('log-clear'),
  logDebug: $('log-debug'),
  tabs: document.querySelectorAll('#account-type .seg'),
  offlinePanel: $('offline-panel'),
  msPanel: $('microsoft-panel'),
  msLogin: $('ms-login'),
  msLogout: $('ms-logout'),
  msSignedIn: $('ms-signed-in'),
  msSignedOut: $('ms-signed-out'),
  msName: $('ms-name'),
  msAvatar: $('ms-avatar')
};

const state = {
  accountType: 'offline',
  account: null,
  running: false,
  busy: false,
  versionTypes: {},
  loaderRequest: 0,
  loaderVersionsReady: true,
  skin: { dataUrl: null, model: 'classic', custom: false },
  viewer: null,
  tab: 'play'
};
const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', optifine: 'OptiFine' };
const MAX_LOG_LINES = 2000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

// ---------- logging ----------
function appendLog(message, level = 'info') {
  const atBottom = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 30;
  const line = document.createElement('div');
  line.className = level;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  el.log.appendChild(line);
  while (el.log.childElementCount > MAX_LOG_LINES) el.log.firstChild.remove();
  if (atBottom) el.log.scrollTop = el.log.scrollHeight;
  if (level !== 'debug') {
    el.logLast.textContent = message;
    el.logLast.classList.toggle('error', level === 'error');
  }
}

function setLogOpen(open) {
  el.logCard.classList.toggle('collapsed', !open);
  el.logToggle.setAttribute('aria-expanded', String(open));
  if (open) el.log.scrollTop = el.log.scrollHeight;
}

// ---------- navigation ----------
function switchTab(tab) {
  state.tab = tab;
  el.navItems.forEach((n) => n.classList.toggle('active', n.dataset.tab === tab));
  el.views.forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  document.querySelector('.views').scrollTop = 0;
  if (tab === 'skins') {
    setSkinStatus('');
    renderSkinPreview().catch((err) => setSkinStatus(`Preview failed: ${err.message}`, true));
  }
}

function renderProfile() {
  const ms = state.accountType === 'microsoft' && state.account;
  el.profileName.textContent = ms ? state.account.name : el.username.value.trim() || 'Player';
  el.profileSub.textContent = ms ? 'Microsoft account' : state.accountType === 'microsoft' ? 'Not signed in' : 'Offline account';
  el.accountDot.classList.toggle('online', Boolean(ms));
  el.accountLabel.textContent = ms ? 'Microsoft - signed in' : state.accountType === 'microsoft' ? 'Microsoft - signed out' : 'Offline mode';
}

function renderSelection() {
  const loaderName = LOADER_NAMES[el.loader.value];
  const sub = el.loader.value !== 'vanilla' && el.loaderVersion.value ? ` ${el.loaderVersion.selectedOptions[0]?.textContent || ''}` : '';
  el.chipVersion.textContent = el.version.value || '-';
  el.chipLoader.textContent = `${loaderName}${sub}`;
  el.modsVersion.textContent = el.version.value || '-';
  el.loaderCards.forEach((c) => c.classList.toggle('active', c.dataset.loader === el.loader.value));
}

// ---------- UI state ----------
function setProgress(percent, { indeterminate = false, error = false } = {}) {
  el.progressBar.classList.toggle('indeterminate', indeterminate);
  el.progressBar.classList.toggle('error', error);
  el.progressBar.style.width = indeterminate || error ? '' : `${Math.max(0, Math.min(100, percent))}%`;
}

function updateLaunchButton() {
  el.launch.classList.toggle('running', state.running);
  if (state.running) {
    el.launch.textContent = 'Stop Game';
    el.launch.disabled = false;
  } else {
    el.launch.textContent = state.busy ? 'Launching...' : 'Launch Game';
    el.launch.disabled = state.busy || !canLaunch();
  }
}

function canLaunch() {
  if (el.loader.value !== 'vanilla' && (!state.loaderVersionsReady || !el.loaderVersion.value)) return false;
  if (state.accountType === 'microsoft') return Boolean(state.account);
  return USERNAME_RE.test(el.username.value.trim());
}

function setAccountType(type) {
  state.accountType = type;
  el.tabs.forEach((t) => t.classList.toggle('active', t.dataset.account === type));
  el.offlinePanel.classList.toggle('hidden', type !== 'offline');
  el.msPanel.classList.toggle('hidden', type !== 'microsoft');
  renderProfile();
  updateLaunchButton();
}

function renderAccount(account) {
  state.account = account;
  el.msSignedIn.classList.toggle('hidden', !account);
  el.msSignedOut.classList.toggle('hidden', Boolean(account));
  if (account) {
    el.msName.textContent = account.name;
    el.msAvatar.src = `https://mc-heads.net/avatar/${encodeURIComponent(account.uuid)}/44`;
  }
  el.skinMsUpload.disabled = !account;
  renderProfile();
  updateLaunchButton();
}

function validateUsername() {
  const ok = USERNAME_RE.test(el.username.value.trim());
  el.usernameHint.classList.toggle('error', !ok && el.username.value.length > 0);
  renderProfile();
  updateLaunchButton();
}

// ---------- versions ----------
async function loadVersions(selected) {
  const result = await api.getVersions(el.showSnapshots.checked);
  if (result.offline) appendLog(`Could not fetch version list (${result.error}). Using cached default.`, 'warn');
  el.version.innerHTML = '';
  state.versionTypes = {};
  for (const v of result.versions) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.type === 'snapshot' ? `${v.id} (snapshot)` : v.id;
    state.versionTypes[v.id] = v.type;
    el.version.appendChild(opt);
  }
  el.version.value = result.versions.some((v) => v.id === selected) ? selected : '1.20.1';
  if (!el.version.value && result.versions[0]) el.version.value = result.versions[0].id;
}

// ---------- mod loaders ----------
async function loadLoaderVersions(preferred) {
  const loader = el.loader.value;
  const version = el.version.value;
  const request = ++state.loaderRequest;
  el.openMods.disabled = loader === 'vanilla';
  el.loaderVersion.innerHTML = '';

  if (loader === 'vanilla') {
    el.loaderVersion.appendChild(new Option('-', ''));
    el.loaderVersion.disabled = true;
    state.loaderVersionsReady = true;
    renderSelection();
    updateLaunchButton();
    return;
  }

  state.loaderVersionsReady = false;
  el.loaderVersion.disabled = true;
  el.loaderVersion.appendChild(new Option('Loading...', ''));
  renderSelection();
  updateLaunchButton();

  const res = await api.getLoaderVersions(loader, version);
  if (request !== state.loaderRequest) return; // a newer selection superseded this one
  el.loaderVersion.innerHTML = '';
  if (!res.ok || !res.versions.length) {
    el.loaderVersion.appendChild(new Option(res.ok ? `No ${LOADER_NAMES[loader]} for ${version}` : 'Failed to load', ''));
    if (!res.ok) appendLog(`Could not load ${LOADER_NAMES[loader]} versions: ${res.error}`, 'error');
  } else {
    for (const v of res.versions) el.loaderVersion.appendChild(new Option(v.label, v.id));
    const pick = res.versions.find((v) => v.id === preferred) || res.versions.find((v) => v.recommended) || res.versions[0];
    el.loaderVersion.value = pick.id;
    el.loaderVersion.disabled = false;
  }
  state.loaderVersionsReady = true;
  renderSelection();
  updateLaunchButton();
}

// ---------- skins ----------
function setSkinStatus(message, isError = false) {
  el.skinStatus.textContent = message || '';
  el.skinStatus.classList.toggle('error', isError);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function drawHead(dataUrl) {
  const ctx = el.skinHead.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 8, 8);
  if (!dataUrl) {
    ctx.fillStyle = '#22222a';
    ctx.fillRect(0, 0, 8, 8);
    return;
  }
  const img = await loadImage(dataUrl);
  ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8); // face
  ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8); // hat layer
}

/** Flat front view used when WebGL (skinview3d) is unavailable. */
async function drawFlatSkin(dataUrl, model) {
  const canvas = el.skinCanvas;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!dataUrl) return;
  const img = await loadImage(dataUrl);
  const legacy = img.height === 32;
  const arm = model === 'slim' ? 3 : 4;
  const s = 9;
  const ox = (canvas.width - 16 * s) / 2;
  const oy = (canvas.height - 32 * s) / 2;
  const part = (sx, sy, w, h, dx, dy) => ctx.drawImage(img, sx, sy, w, h, ox + dx * s, oy + dy * s, w * s, h * s);
  part(8, 8, 8, 8, 4, 0); part(40, 8, 8, 8, 4, 0); // head + hat
  part(20, 20, 8, 12, 4, 8); // body
  part(44, 20, arm, 12, 4 - arm, 8); // right arm
  part(legacy ? 44 : 36, legacy ? 20 : 52, arm, 12, 12, 8); // left arm
  part(4, 20, 4, 12, 4, 20); // right leg
  part(legacy ? 4 : 20, legacy ? 20 : 52, 4, 12, 8, 20); // left leg
}

function ensureViewer() {
  if (state.viewer !== null) return state.viewer;
  try {
    if (!window.skinview3d) throw new Error('skinview3d not loaded');
    const viewer = new skinview3d.SkinViewer({ canvas: el.skinCanvas, width: 260, height: 340 });
    viewer.background = null;
    viewer.fov = 50;
    viewer.zoom = 0.85;
    viewer.autoRotate = true;
    viewer.autoRotateSpeed = 0.6;
    viewer.animation = new skinview3d.WalkingAnimation();
    viewer.animation.speed = 0.6;
    viewer.globalLight.intensity = 3;
    viewer.cameraLight.intensity = 0.6;
    state.viewer = viewer;
  } catch (err) {
    appendLog(`3D skin preview unavailable (${err.message}), using 2D preview.`, 'warn');
    state.viewer = false;
    el.skinAnim.classList.add('hidden');
  }
  return state.viewer;
}

async function renderSkinPreview() {
  const { dataUrl, model } = state.skin;
  el.skinEmpty.classList.toggle('hidden', Boolean(dataUrl));
  const viewer = ensureViewer();
  if (viewer) {
    if (dataUrl) await viewer.loadSkin(dataUrl, { model: model === 'slim' ? 'slim' : 'default' });
    else viewer.resetSkin();
  } else {
    await drawFlatSkin(dataUrl, model);
  }
}

function applySkinState(skin) {
  state.skin = { ...state.skin, ...skin };
  const { model, dataUrl, applyOfflineSkin } = state.skin;
  el.skinModelTabs.forEach((t) => t.classList.toggle('active', t.dataset.model === model));
  if (typeof applyOfflineSkin === 'boolean') el.skinOffline.checked = applyOfflineSkin;
  drawHead(dataUrl).catch(() => {});
  if (state.tab === 'skins') renderSkinPreview().catch(() => {});
}

async function refreshSkin() {
  applySkinState(await api.getSkin());
}

async function runSkinAction(button, action, successMessage) {
  button.disabled = true;
  setSkinStatus('Working...');
  try {
    const res = await action();
    if (!res) return;
    if (!res.ok) return setSkinStatus(res.error, true);
    if (!res.skin) return setSkinStatus('');
    applySkinState(res.skin);
    setSkinStatus(successMessage);
    appendLog(successMessage);
  } finally {
    button.disabled = button === el.skinMsUpload ? !state.account : false;
  }
}

// ---------- java ----------
async function onDetectJava() {
  el.javaDetect.disabled = true;
  el.javaList.innerHTML = '<small class="hint">Scanning for Java installations...</small>';
  const res = await api.detectJava();
  el.javaDetect.disabled = false;
  el.javaList.innerHTML = '';
  if (!res.ok || !res.javas.length) {
    el.javaList.innerHTML = `<small class="hint">${res.ok ? 'No Java found - the launcher will download one automatically.' : 'Detection failed.'}</small>`;
    return;
  }
  const auto = document.createElement('button');
  auto.className = 'java-item';
  auto.innerHTML = '<span>Automatic (recommended)</span><small>picks the right Java per version</small>';
  auto.dataset.path = '';
  el.javaList.appendChild(auto);
  for (const j of res.javas) {
    const item = document.createElement('button');
    item.className = 'java-item';
    item.dataset.path = j.path;
    const name = document.createElement('span');
    name.textContent = `Java ${j.version}${j.vendor ? ` - ${j.vendor}` : ''}${j.is64Bit ? '' : ' (32-bit)'}`;
    const where = document.createElement('small');
    where.textContent = j.path;
    item.append(name, where);
    el.javaList.appendChild(item);
  }
  markJavaSelection();
}

function markJavaSelection() {
  el.javaList.querySelectorAll('.java-item').forEach((i) => i.classList.toggle('active', i.dataset.path === el.javaPath.value.trim()));
}

const persist = () => api.saveSettings(collectSettings());

function collectSettings() {
  return {
    username: el.username.value.trim(),
    version: el.version.value,
    versionType: state.versionTypes[el.version.value] || 'release',
    memoryMax: Number(el.memory.value),
    memoryMin: Math.min(2, Number(el.memory.value)),
    javaPath: el.javaPath.value.trim(),
    loader: el.loader.value,
    loaderVersion: el.loaderVersion.value,
    loaderLabel: el.loaderVersion.selectedOptions[0]?.textContent || '',
    showSnapshots: el.showSnapshots.checked,
    accountType: state.accountType
  };
}

// ---------- actions ----------
async function onLaunchClick() {
  if (state.running) {
    await api.kill();
    return;
  }
  state.busy = true;
  updateLaunchButton();
  setProgress(0, { indeterminate: true });
  el.statusText.textContent = 'Starting...';
  el.downloadFile.textContent = '';
  el.downloadSpeed.textContent = '';

  const res = await api.launch(collectSettings());
  if (!res.ok) {
    setLogOpen(true);
    state.busy = false;
    appendLog(res.error, 'error');
    el.statusText.textContent = res.error;
    setProgress(0, { error: true });
    updateLaunchButton();
  }
}

async function onMicrosoftLogin() {
  el.msLogin.disabled = true;
  el.msLogin.textContent = 'Waiting for login...';
  appendLog('Opening Microsoft login window...');
  const res = await api.loginMicrosoft();
  el.msLogin.disabled = false;
  el.msLogin.textContent = 'Sign in with Microsoft';
  if (res.ok) {
    renderAccount(res.account);
    refreshSkin();
    appendLog(`Signed in as ${res.account.name}`);
  } else {
    appendLog(`Microsoft login failed: ${res.error}`, 'error');
  }
}

// ---------- IPC events ----------
api.onStatus(({ state: s, message }) => {
  el.statusText.textContent = message;
  switch (s) {
    case 'java':
    case 'preparing':
    case 'launching':
    case 'extracting':
      setProgress(0, { indeterminate: true });
      break;
    case 'running':
      state.busy = false;
      state.running = true;
      setProgress(100);
      el.heroSub.textContent = message;
      el.heroSub.classList.add('running');
      el.downloadFile.textContent = '';
      el.downloadSpeed.textContent = '';
      el.progressMeta.textContent = '';
      break;
    case 'error':
      state.busy = false;
      state.running = false;
      setProgress(0, { error: true });
      el.heroSub.textContent = 'Launch failed';
      el.heroSub.classList.remove('running');
      setLogOpen(true);
      break;
    case 'idle':
      state.busy = false;
      state.running = false;
      setProgress(0);
      el.heroSub.textContent = /crashed/.test(message) ? message : 'Ready to play';
      el.heroSub.classList.remove('running');
      break;
  }
  updateLaunchButton();
});

api.onProgress(({ label, task, total, percent }) => {
  el.statusText.textContent = label;
  el.progressMeta.textContent = total ? `${task} / ${total} (${percent}%)` : '';
  setProgress(percent);
});

api.onDownload(({ name, current, total, speed }) => {
  el.downloadFile.textContent = total ? `${name} - ${Math.round((current / total) * 100)}%` : name;
  el.downloadSpeed.textContent = speed;
});

api.onLog(({ message, level }) => appendLog(message, level));
api.onClosed(({ code, stopped }) => {
  if (code !== 0 && !stopped) {
    setLogOpen(true);
    setProgress(0, { error: true });
  }
  state.running = false;
  updateLaunchButton();
});
api.onAuthChanged((account) => {
  renderAccount(account);
  refreshSkin();
});

// ---------- DOM events ----------
el.launch.addEventListener('click', onLaunchClick);
el.username.addEventListener('input', validateUsername);
function updateMemoryLabel() {
  el.memoryValue.textContent = el.memory.value;
  const pct = ((el.memory.value - el.memory.min) / (el.memory.max - el.memory.min)) * 100;
  el.memory.style.setProperty('--fill', `${pct}%`);
}
el.memory.addEventListener('input', updateMemoryLabel);
el.memory.addEventListener('change', persist);
el.username.addEventListener('change', persist);
el.javaPath.addEventListener('change', () => { markJavaSelection(); persist(); });
el.javaDetect.addEventListener('click', onDetectJava);
el.javaList.addEventListener('click', (e) => {
  const item = e.target.closest('.java-item');
  if (!item) return;
  el.javaPath.value = item.dataset.path;
  markJavaSelection();
  persist();
});
el.version.addEventListener('change', () => { renderSelection(); loadLoaderVersions(el.loaderVersion.value); });
el.loader.addEventListener('change', () => loadLoaderVersions());
el.loaderVersion.addEventListener('change', () => { renderSelection(); updateLaunchButton(); });
el.loaderCards.forEach((c) => c.addEventListener('click', () => {
  if (el.loader.value === c.dataset.loader) return;
  el.loader.value = c.dataset.loader;
  el.loader.dispatchEvent(new Event('change'));
}));
el.navItems.forEach((n) => n.addEventListener('click', () => switchTab(n.dataset.tab)));
el.accountStatus.addEventListener('click', () => switchTab('settings'));
el.openMods.addEventListener('click', () => api.openModsDir(el.loader.value, el.version.value));

el.skinAnim.addEventListener('click', () => {
  if (!state.viewer) return;
  state.viewer.animation.paused = !state.viewer.animation.paused;
  state.viewer.autoRotate = !state.viewer.animation.paused;
  el.skinAnim.textContent = state.viewer.animation.paused ? 'Play animation' : 'Pause animation';
});
el.skinModelTabs.forEach((t) =>
  t.addEventListener('click', async () => applySkinState(await api.setSkinOptions({ model: t.dataset.model })))
);
el.skinOffline.addEventListener('change', async () =>
  applySkinState(await api.setSkinOptions({ applyOfflineSkin: el.skinOffline.checked }))
);
el.skinUpload.addEventListener('click', () => runSkinAction(el.skinUpload, api.pickSkinFile, 'Skin loaded from file'));
el.skinUrlBtn.addEventListener('click', () =>
  runSkinAction(el.skinUrlBtn, () => api.skinFromUrl(el.skinUrl.value), 'Skin imported from URL')
);
el.skinPlayerBtn.addEventListener('click', () =>
  runSkinAction(el.skinPlayerBtn, () => api.skinFromPlayer(el.skinPlayer.value), `Imported skin of ${el.skinPlayer.value.trim()}`)
);
el.skinUrl.addEventListener('keydown', (e) => e.key === 'Enter' && el.skinUrlBtn.click());
el.skinPlayer.addEventListener('keydown', (e) => e.key === 'Enter' && el.skinPlayerBtn.click());
el.skinMsUpload.addEventListener('click', () =>
  runSkinAction(el.skinMsUpload, api.uploadSkinToAccount, 'Skin uploaded to your Microsoft account')
);
el.skinClear.addEventListener('click', async () => {
  await api.clearSkin();
  await refreshSkin();
  setSkinStatus('Skin reset');
});
el.showSnapshots.addEventListener('change', async () => {
  persist();
  await loadVersions(el.version.value);
  renderSelection();
  await loadLoaderVersions(el.loaderVersion.value);
});
el.openDir.addEventListener('click', () => api.openGameDir());
el.tabs.forEach((t) => t.addEventListener('click', () => { setAccountType(t.dataset.account); persist(); }));
el.msLogin.addEventListener('click', onMicrosoftLogin);
el.msLogout.addEventListener('click', async () => {
  await api.logout();
  renderAccount(null);
  refreshSkin();
  appendLog('Signed out of Microsoft account');
});
el.logToggle.addEventListener('click', () => setLogOpen(el.logCard.classList.contains('collapsed')));
el.logClear.addEventListener('click', () => (el.log.innerHTML = ''));
el.logDebug.addEventListener('change', () => el.log.classList.toggle('hide-debug', !el.logDebug.checked));

// ---------- init ----------
(async function init() {
  const settings = await api.getSettings();
  el.username.value = settings.username || '';
  el.memory.value = settings.memoryMax || 4;
  updateMemoryLabel();
  el.javaPath.value = settings.javaPath || '';
  el.showSnapshots.checked = Boolean(settings.showSnapshots);
  renderAccount(await api.getAccount());
  setAccountType(settings.accountType === 'microsoft' ? 'microsoft' : 'offline');
  validateUsername();
  el.loader.value = LOADER_NAMES[settings.loader] ? settings.loader : 'vanilla';
  await loadVersions(settings.version || '1.20.1');
  await Promise.all([loadLoaderVersions(settings.loaderVersion), refreshSkin()]);
  appendLog('Launcher ready.');
})();

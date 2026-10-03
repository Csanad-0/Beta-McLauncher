const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = [
  'launcher:progress',
  'launcher:download',
  'launcher:log',
  'launcher:status',
  'launcher:closed',
  'auth:changed'
];

function subscribe(channel, callback) {
  if (!EVENT_CHANNELS.includes(channel)) throw new Error(`Blocked channel: ${channel}`);
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('launcherAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  getVersions: (showSnapshots) => ipcRenderer.invoke('versions:list', { showSnapshots }),

  detectJava: () => ipcRenderer.invoke('java:detect'),
  getLoaderVersions: (loader, version) => ipcRenderer.invoke('loaders:list', { loader, version }),

  getSkin: () => ipcRenderer.invoke('skin:get'),
  pickSkinFile: () => ipcRenderer.invoke('skin:pick-file'),
  skinFromUrl: (url) => ipcRenderer.invoke('skin:from-url', url),
  skinFromPlayer: (name) => ipcRenderer.invoke('skin:from-player', name),
  setSkinOptions: (options) => ipcRenderer.invoke('skin:set-options', options),
  clearSkin: () => ipcRenderer.invoke('skin:clear'),
  uploadSkinToAccount: () => ipcRenderer.invoke('skin:upload-account'),

  getAccount: () => ipcRenderer.invoke('auth:status'),
  loginMicrosoft: () => ipcRenderer.invoke('auth:microsoft'),
  logout: () => ipcRenderer.invoke('auth:logout'),

  launch: (options) => ipcRenderer.invoke('game:launch', options),
  kill: () => ipcRenderer.invoke('game:kill'),
  openGameDir: () => ipcRenderer.invoke('app:open-game-dir'),
  openModsDir: (loader, version) => ipcRenderer.invoke('app:open-mods-dir', { loader, version }),

  onProgress: (cb) => subscribe('launcher:progress', cb),
  onDownload: (cb) => subscribe('launcher:download', cb),
  onLog: (cb) => subscribe('launcher:log', cb),
  onStatus: (cb) => subscribe('launcher:status', cb),
  onClosed: (cb) => subscribe('launcher:closed', cb),
  onAuthChanged: (cb) => subscribe('auth:changed', cb)
});

# Minecraft Launcher

Electron launcher built on [`minecraft-launcher-core`](https://github.com/Pierce01/MinecraftLauncher-core) and [`msmc`](https://github.com/Hanro50/MSMC).

## Run

```bash
npm install
npm start
```

Requires Java on `PATH` (or set a custom Java path in the UI): Java 17 for 1.18-1.20.4, Java 21 for 1.20.5+, Java 8 for 1.16 and older.

Game files live in Electron's `userData` folder under `minecraft/` (use "Open game folder" in the UI).

## Structure

- `src/main.js`: main process, window, IPC handlers, Microsoft auth (msmc) and settings persistence
- `src/preload.js`: `contextBridge` API (`window.launcherAPI`) with an allow-list of event channels
- `src/launcher.js`: Java check, version manifest, MCLC launch, progress/download/log events
- `src/ui/`: `index.html`, `styles.css`, `renderer.js`

const { app, BrowserWindow, session, dialog, protocol, net, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// La app se sirve por un protocolo propio para que módulos, fetch y AudioWorklet funcionen.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

let win;
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function readCfg() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (e) { return {}; } }
function writeCfg(c) { try { fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(c)); } catch (e) {} }

async function loadSoundfont(p) {
  const buf = await fs.promises.readFile(p);
  return { name: path.basename(p), path: p, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length) };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#14161c',
    title: 'Piano Tutor',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadURL('app://local/index.html');
}

// Actualización automática desde GitHub Releases (solo en la app instalada).
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Reiniciar ahora', 'Más tarde'],
        defaultId: 0,
        title: 'Actualización lista',
        message: 'Piano Tutor ' + info.version + ' está listo.',
        detail: 'Reinicia para usar la nueva versión (si no, se instalará al cerrar la app).'
      })
      .then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', () => {}); // sin internet: se ignora
  autoUpdater.checkForUpdates().catch(() => {});
}

app.whenReady().then(() => {
  const root = path.join(__dirname, 'src');
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) return new Response('Prohibido', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const ses = session.defaultSession;
  const allowed = ['midi', 'midiSysex'];
  // Permite usar el piano MIDI sin que aparezca ningún aviso.
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.includes(permission)));
  ses.setPermissionCheckHandler((wc, permission) => allowed.includes(permission));

  // Biblioteca de SoundFonts: lista de rutas + la que está activa.
  const getLib = () => {
    const c = readCfg();
    let lib = Array.isArray(c.library) ? c.library : [];
    if (c.soundfont && !lib.includes(c.soundfont)) lib = [...lib, c.soundfont];
    return { c, lib };
  };
  ipcMain.handle('sf:list', () => {
    const { c, lib } = getLib();
    return {
      current: c.soundfont || '',
      list: lib.map((p) => ({ path: p, name: path.basename(p).replace(/.(sf2|sf3|sfogg|dls)$/i, ''), missing: !fs.existsSync(p) }))
    };
  });
  ipcMain.handle('sf:add', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Añadir SoundFonts',
      filters: [{ name: 'SoundFont', extensions: ['sf2', 'sf3', 'sfogg', 'dls'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const { c, lib } = getLib();
    writeCfg({ ...c, library: [...new Set([...lib, ...r.filePaths])] });
    return { first: r.filePaths[0] };
  });
  ipcMain.handle('sf:select', async (e, p) => {
    const { c, lib } = getLib();
    if (!lib.includes(p) || !fs.existsSync(p)) return null;
    const sf = await loadSoundfont(p);
    writeCfg({ ...c, library: lib, soundfont: p });
    return sf;
  });
  ipcMain.handle('sf:remove', (e, p) => {
    const { c, lib } = getLib();
    writeCfg({ ...c, library: lib.filter((x) => x !== p), soundfont: c.soundfont === p ? null : c.soundfont });
  });
  ipcMain.handle('sf:saved', async () => {
    const p = readCfg().soundfont;
    if (!p || !fs.existsSync(p)) return null;
    try { return await loadSoundfont(p); } catch (e) { return null; }
  });
  ipcMain.handle('sf:clear', () => { writeCfg({ ...readCfg(), soundfont: null }); });

  ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });

  createWindow();
  setupAutoUpdate();
});

app.on('window-all-closed', () => app.quit());

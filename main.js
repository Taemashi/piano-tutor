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

  ipcMain.handle('sf:choose', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Elegir SoundFont',
      filters: [{ name: 'SoundFont', extensions: ['sf2', 'sf3', 'sfogg', 'dls'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const sf = await loadSoundfont(r.filePaths[0]);
    writeCfg({ ...readCfg(), soundfont: sf.path });
    return sf;
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

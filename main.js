const { app, BrowserWindow, session, dialog } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#14161c',
    title: 'Piano Tutor',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
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
  const ses = session.defaultSession;
  const allowed = ['midi', 'midiSysex'];
  // Permite usar el piano MIDI sin que aparezca ningún aviso.
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.includes(permission)));
  ses.setPermissionCheckHandler((wc, permission) => allowed.includes(permission));
  createWindow();
  setupAutoUpdate();
});

app.on('window-all-closed', () => app.quit());

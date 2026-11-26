const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pianoApi', {
  chooseSoundfont: () => ipcRenderer.invoke('sf:choose'),
  savedSoundfont: () => ipcRenderer.invoke('sf:saved'),
  clearSoundfont: () => ipcRenderer.invoke('sf:clear'),
  version: ipcRenderer.sendSync('app:version')
});

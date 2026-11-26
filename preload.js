const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pianoApi', {
  listSoundfonts: () => ipcRenderer.invoke('sf:list'),
  addSoundfonts: () => ipcRenderer.invoke('sf:add'),
  selectSoundfont: (p) => ipcRenderer.invoke('sf:select', p),
  removeSoundfont: (p) => ipcRenderer.invoke('sf:remove', p),
  savedSoundfont: () => ipcRenderer.invoke('sf:saved'),
  clearSoundfont: () => ipcRenderer.invoke('sf:clear'),
  version: ipcRenderer.sendSync('app:version')
});

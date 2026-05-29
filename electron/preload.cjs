// @ts-check
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tinyHermes', {
  getSignal: () => ipcRenderer.invoke('signal:get'),
  refreshSignal: () => ipcRenderer.invoke('signal:refresh'),
  quit: () => ipcRenderer.invoke('window:quit'),
  openExternal: (url) => ipcRenderer.invoke('window:open-external', url),
  setInteractive: (interactive) => ipcRenderer.invoke('window:set-interactive', !!interactive),
  getBounds: () => ipcRenderer.invoke('window:get-bounds'),
});

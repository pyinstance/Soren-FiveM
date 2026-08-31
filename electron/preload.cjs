const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('appAPI', {
  getCatalog: () => ipcRenderer.invoke('catalog:get'),
  openCatalogFolder: () => ipcRenderer.invoke('catalog:open-folder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  chooseFolder: (key) => ipcRenderer.invoke('settings:choose-folder', key),
  clearFolder: (key) => ipcRenderer.invoke('settings:clear-folder', key),
  prepareInstall: (item) => ipcRenderer.invoke('install:prepare', item),
  confirmInstall: (payload) => ipcRenderer.invoke('install:confirm', payload),
  cancelPrepared: (jobId) => ipcRenderer.invoke('install:cancel-prepared', jobId),
  getHistory: () => ipcRenderer.invoke('history:get'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  verifyIntegrity: () => ipcRenderer.invoke('security:verify'),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  }
})

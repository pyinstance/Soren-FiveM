const { contextBridge, ipcRenderer, webUtils, clipboard } = require('electron')

contextBridge.exposeInMainWorld('appAPI', {
  getPacks: () => ipcRenderer.invoke('packs:get'),
  copyText: (text) => clipboard.writeText(String(text || '')),
  openPacksFolder: () => ipcRenderer.invoke('packs:open-folder'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  addPackPath: (sourcePath) => ipcRenderer.invoke('packs:add-file', sourcePath),
  choosePackFile: () => ipcRenderer.invoke('packs:choose-file'),

  launchFiveM: () => ipcRenderer.invoke('fivem:launch'),
  getServers: (force = false) => ipcRenderer.invoke('servers:list', force),
  joinServer: (code) => ipcRenderer.invoke('servers:join', code),
  verifyPaths: () => ipcRenderer.invoke('paths:verify'),
  prepareReshadeFolders: () => ipcRenderer.invoke('reshade:prepare-folders'),
  downloadReshade: () => ipcRenderer.invoke('reshade:download'),
  launchReshadeSetup: () => ipcRenderer.invoke('reshade:launch-setup'),
  finishReshadeInstall: () => ipcRenderer.invoke('reshade:finish-install'),
  getReshadeStatus: () => ipcRenderer.invoke('reshade:status'),
  acknowledgeReshade: () => ipcRenderer.invoke('reshade:acknowledge'),
  getActiveSetup: () => ipcRenderer.invoke('active:get'),

  getInstallQueue: () => ipcRenderer.invoke('queue:get'),
  addInstallQueueItem: (item) => ipcRenderer.invoke('queue:add', item),
  removeInstallQueueItem: (itemId) => ipcRenderer.invoke('queue:remove', itemId),
  clearInstallQueue: () => ipcRenderer.invoke('queue:clear'),

  getBackups: () => ipcRenderer.invoke('backups:get'),
  deleteBackup: (id) => ipcRenderer.invoke('backups:delete', id),
  restoreBackup: (id) => ipcRenderer.invoke('backups:restore', id),

  getFavorites: () => ipcRenderer.invoke('favorites:get'),
  setFavorite: (itemId, favorite) => ipcRenderer.invoke('favorites:set', { itemId, favorite }),
  restoreVanilla: () => ipcRenderer.invoke('restore:vanilla'),
  openDiscord: () => ipcRenderer.invoke('discord:open'),

  getAccount: () => ipcRenderer.invoke('account:get'),
  generateAccountKey: () => ipcRenderer.invoke('account:generate-key'),
  beginDiscordClaim: (payload) => ipcRenderer.invoke('account:begin-discord', payload),
  checkAccountClaim: (payload) => ipcRenderer.invoke('account:check-claim', payload),
  loginAccount: (payload) => ipcRenderer.invoke('account:login', payload),
  logoutAccount: () => ipcRenderer.invoke('account:logout'),
  openSignupDiscord: () => ipcRenderer.invoke('account:open-invite'),

  getCloudFiles: () => ipcRenderer.invoke('cloud:list'),
  uploadPackToCloud: (payload) => ipcRenderer.invoke('cloud:upload-local', payload),
  downloadCloudPack: (file) => ipcRenderer.invoke('cloud:download-local', file),
  deleteCloudPack: (fileId) => ipcRenderer.invoke('cloud:delete', fileId),
  getOwnerUsers: () => ipcRenderer.invoke('owner:users'),
  onPacksChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('packs:changed', handler)
    return () => ipcRenderer.removeListener('packs:changed', handler)
  },

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

  onCloudProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('cloud:progress', handler)
    return () => ipcRenderer.removeListener('cloud:progress', handler)
  },
  onDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
  onInstallProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('install:progress', handler)
    return () => ipcRenderer.removeListener('install:progress', handler)
  }
})

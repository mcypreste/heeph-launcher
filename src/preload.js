const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  minimize:         ()      => ipcRenderer.send('win-min'),
  maximize:         ()      => ipcRenderer.send('win-max'),
  close:            ()      => ipcRenderer.send('win-close'),
  getInfo:          ()      => ipcRenderer.invoke('get-info'),
  launchVanilla:    (c)     => ipcRenderer.invoke('launch-vanilla', c),
  heephUpdate:      ()      => ipcRenderer.invoke('heeph-update'),
  heephPreflight:   (c)     => ipcRenderer.invoke('heeph-preflight', c),
  heephRepair:      (c)     => ipcRenderer.invoke('heeph-repair', c),
  heephPlay:        (c)     => ipcRenderer.invoke('heeph-play', c),
  heephStatus:      ()      => ipcRenderer.invoke('heeph-status'),
  launchModrinth:   (c)     => ipcRenderer.invoke('launch-modrinth', c),
  openMcFolder:     ()      => ipcRenderer.invoke('open-mc-folder'),
  openUrl:          (url)   => ipcRenderer.invoke('open-modrinth-url', { url }),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard-write-text', { text }),
  modrinthFetch:    (url)   => ipcRenderer.invoke('modrinth-fetch', { url }),
  skinsList:        ()      => ipcRenderer.invoke('skins-list'),
  skinSelect:       (c)     => ipcRenderer.invoke('skin-select', c),
  skinUpload:       (c)     => ipcRenderer.invoke('skin-upload', c),
  skinRemove:       (c)     => ipcRenderer.invoke('skin-remove', c),
  skinGetConfig:    ()      => ipcRenderer.invoke('skin-get-config'),
  skinSetEly:       (c)     => ipcRenderer.invoke('skin-set-ely', c),
  skinPush:         (c)     => ipcRenderer.invoke('skin-push', c),
  skinGetServer:    ()      => ipcRenderer.invoke('skin-get-server'),
  skinServerSet:    (c)     => ipcRenderer.invoke('skin-server-set', c),
  onUpdateProgress: (cb)    => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, payload) => {
      try { cb(payload); } catch (_) {}
    };
    ipcRenderer.on('update-progress', handler);
    return () => ipcRenderer.removeListener('update-progress', handler);
  },

  launcherCheckUpdates: () => ipcRenderer.invoke('launcher-check-updates'),
  launcherInstallUpdate: () => ipcRenderer.invoke('launcher-install-update'),
  onLauncherUpdate: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, payload) => {
      try { cb(payload); } catch (_) {}
    };
    ipcRenderer.on('launcher-update', handler);
    return () => ipcRenderer.removeListener('launcher-update', handler);
  },

  microsoftLogin: () => ipcRenderer.invoke('ms-login'),
  microsoftLogout: () => ipcRenderer.invoke('ms-logout'),
  microsoftStatus: () => ipcRenderer.invoke('ms-status'),
  cosmeticsFetch: () => ipcRenderer.invoke('cosmetics-fetch'),
  cosmeticsEquip: (c) => ipcRenderer.invoke('cosmetics-equip', c),
  onMicrosoftDeviceCode: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, payload) => {
      try { cb(payload); } catch (_) {}
    };
    ipcRenderer.on('ms-device-code', handler);
    return () => ipcRenderer.removeListener('ms-device-code', handler);
  },

  onMicrosoftAuth: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, payload) => {
      try { cb(payload); } catch (_) {}
    };
    ipcRenderer.on('ms-auth', handler);
    return () => ipcRenderer.removeListener('ms-auth', handler);
  },

  accountsList: () => ipcRenderer.invoke('accounts-list'),
  accountsSetActive: (c) => ipcRenderer.invoke('accounts-set-active', c),
  accountsRemove: (c) => ipcRenderer.invoke('accounts-remove', c),
  accountsUpsertOffline: (c) => ipcRenderer.invoke('accounts-upsert-offline', c),

  officialSkinUpload: (c) => ipcRenderer.invoke('official-skin-upload', c),
  officialSkinReset: () => ipcRenderer.invoke('official-skin-reset'),
  officialSkinGet: () => ipcRenderer.invoke('official-skin-get'),

  launcherSettingsGet: () => ipcRenderer.invoke('launcher-settings-get'),
  launcherSettingsSet: (c) => ipcRenderer.invoke('launcher-settings-set', c),

  appSettingsGet: () => ipcRenderer.invoke('app-settings-get'),
  appSettingsSet: (c) => ipcRenderer.invoke('app-settings-set', c),

  openLauncherDataFolder: () => ipcRenderer.invoke('open-launcher-data-folder'),
  clearLauncherCache: () => ipcRenderer.invoke('clear-launcher-cache'),
  clearLauncherLogs: () => ipcRenderer.invoke('clear-launcher-logs'),
});

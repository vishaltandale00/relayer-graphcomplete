const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("relayerDesktop", {
  platform: process.platform,
  account: {
    read: () => ipcRenderer.invoke("relayer:account-read"),
    login: () => ipcRenderer.invoke("relayer:account-login"),
    logout: () => ipcRenderer.invoke("relayer:account-logout"),
    onChanged: (callback) => subscribe("relayer:account-changed", callback),
  },
  folder: {
    choose: () => ipcRenderer.invoke("relayer:folder-choose"),
  },
  conversation: {
    export: (threadId) => ipcRenderer.invoke("relayer:conversation-export", threadId),
  },
  models: {
    settingsOpened: () => ipcRenderer.invoke("relayer:model-catalog-settings-open"),
    refresh: (providerId) => ipcRenderer.invoke("relayer:model-catalog-refresh", providerId),
  },
  appearance: {
    read: () => ipcRenderer.invoke("relayer:appearance-read"),
    set: (appearance) => ipcRenderer.invoke("relayer:appearance-set", appearance),
  },
  tutorial: {
    read: (context) => ipcRenderer.invoke("relayer:tutorial-read", context),
    beginAutomatic: (context) => ipcRenderer.invoke("relayer:tutorial-begin-automatic", context),
    beginManual: () => ipcRenderer.invoke("relayer:tutorial-begin-manual"),
    dismiss: () => ipcRenderer.invoke("relayer:tutorial-dismiss"),
    complete: () => ipcRenderer.invoke("relayer:tutorial-complete"),
  },
  updater: {
    status: () => ipcRenderer.invoke("relayer:update-status"),
    check: () => ipcRenderer.invoke("relayer:update-check"),
    download: () => ipcRenderer.invoke("relayer:update-download"),
    install: () => ipcRenderer.invoke("relayer:update-install"),
    setChannel: (channel) => ipcRenderer.invoke("relayer:update-channel", channel),
    onChanged: (callback) => subscribe("relayer:update-changed", callback),
  },
});

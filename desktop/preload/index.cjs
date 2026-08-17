const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("relayerDesktop", {
  account: {
    read: () => ipcRenderer.invoke("relayer:account-read"),
    login: () => ipcRenderer.invoke("relayer:account-login"),
    logout: () => ipcRenderer.invoke("relayer:account-logout"),
    onChanged: (callback) => subscribe("relayer:account-changed", callback),
  },
  folder: {
    choose: () => ipcRenderer.invoke("relayer:folder-choose"),
  },
  appearance: {
    read: () => ipcRenderer.invoke("relayer:appearance-read"),
    set: (appearance) => ipcRenderer.invoke("relayer:appearance-set", appearance),
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

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("relayerEval", {
  catalog: () => ipcRenderer.invoke("relayer-eval:catalog"),
  listRuns: () => ipcRenderer.invoke("relayer-eval:list-runs"),
  getRun: (runId) => ipcRenderer.invoke("relayer-eval:get-run", runId),
  createRun: (selection) => ipcRenderer.invoke("relayer-eval:create-run", selection),
  openReview: (executionId) => ipcRenderer.invoke("relayer-eval:open-review", executionId),
  onRunsChanged: (callback) => subscribe("relayer-eval:runs-changed", callback),
});

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayerEvalTrace", {
  load: (executionId, interactionId) => ipcRenderer.invoke("relayer-eval:load-candidate-trace", executionId, interactionId),
});

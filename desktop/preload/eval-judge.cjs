const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayerEval", {
  getRun: (runId) => ipcRenderer.invoke("relayer-eval:get-run", runId),
  loadJudgeScreenshot: (input) => ipcRenderer.invoke("relayer-eval:load-judge-screenshot", input),
});

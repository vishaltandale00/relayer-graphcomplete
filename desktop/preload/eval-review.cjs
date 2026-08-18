const { contextBridge, ipcRenderer } = require("electron");

const argument = process.argv.find((value) => value.startsWith("--relayer-eval-execution="));
const executionId = argument ? argument.slice("--relayer-eval-execution=".length) : "";

contextBridge.exposeInMainWorld("relayerEvalReview", {
  context: () => ipcRenderer.invoke("relayer-eval:review-context", executionId),
});

const { contextBridge, ipcRenderer } = require("electron");

const argument = process.argv.find((value) => value.startsWith("--relayer-eval-execution="));
const executionId = argument ? argument.slice("--relayer-eval-execution=".length) : "";
let presentationAdapter;

ipcRenderer.on("relayer-eval:review-command", async (event, request) => {
  const { responseChannel, command, payload } = request || {};
  if (event.sender !== ipcRenderer || typeof responseChannel !== "string") return;
  try {
    if (!presentationAdapter) throw new Error("The production workspace is not ready for review tools.");
    const operation = presentationAdapter[command];
    if (typeof operation !== "function") throw new Error(`Unknown review presentation command: ${command}`);
    const result = await operation(payload);
    ipcRenderer.send(responseChannel, { result });
  } catch (error) {
    ipcRenderer.send(responseChannel, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

contextBridge.exposeInMainWorld("relayerEvalReview", {
  context: () => ipcRenderer.invoke("relayer-eval:review-context", executionId),
  registerPresentationAdapter: (adapter) => {
    const required = [
      "snapshot",
      "capturePlan",
      "prepareCaptureTile",
      "restoreCapture",
      "activate",
      "history",
    ];
    if (!adapter || required.some((name) => typeof adapter[name] !== "function")) {
      throw new Error("The review presentation adapter is incomplete.");
    }
    presentationAdapter = adapter;
    const state = presentationAdapter.snapshot();
    const navigationToken = new URL(location.href).searchParams.get("reviewSession");
    ipcRenderer.send("relayer-eval:review-workspace-ready", {
      executionId,
      threadId: state?.threadId == null ? "" : String(state.threadId),
      turnId: state?.turnId == null ? "" : String(state.turnId),
      navigationToken: navigationToken || "",
    });
  },
});

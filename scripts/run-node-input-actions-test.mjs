import { fileURLToPath } from "node:url";
import electron from "electron";
import { runElectronProof } from "./electron-proof-process.mjs";

await runElectronProof({
  executable: electron,
  script: fileURLToPath(new URL("./test-desktop-node-input-actions.mjs", import.meta.url)),
  label: "Node-input Electron proof",
  resultVariable: "RELAYER_NODE_INPUT_RESULT_FILE",
  profileVariable: "RELAYER_NODE_INPUT_ELECTRON_PROFILE",
});

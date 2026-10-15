import { fileURLToPath } from "node:url";
import electron from "electron";
import { runElectronProof } from "./electron-proof-process.mjs";

await runElectronProof({
  executable: electron,
  script: fileURLToPath(new URL("./test-desktop-stop.mjs", import.meta.url)),
  label: "Stop Electron proof",
  resultVariable: "RELAYER_STOP_RESULT_FILE",
  profileVariable: "RELAYER_STOP_ELECTRON_PROFILE",
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHTTPCoreAdmissionPortfolio } from "../packages/eval-runner/dist/index.js";

const rootDirectory = await mkdtemp(join(tmpdir(), "relayer-httpcore-admission-"));
const cacheDirectory = process.env.RELAYER_HTTPCORE_CACHE || join(rootDirectory, "cache");

try {
  const receipt = await runHTTPCoreAdmissionPortfolio({ cacheDirectory, rootDirectory });
  const sealedReceipt = JSON.parse(await readFile(new URL("../eval-cases/httpcore-cancellation-pool/admission/receipt.json", import.meta.url), "utf8"));
  if (JSON.stringify(receipt) !== JSON.stringify(sealedReceipt)) {
    throw new Error("Fresh HTTPCore admission result does not match the sealed receipt.");
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.result !== "pass") process.exitCode = 1;
} finally {
  await rm(rootDirectory, { recursive: true, force: true });
}

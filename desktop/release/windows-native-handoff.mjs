import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { requireLadybugDistributionLicenseReady } from "../packaging/pinned-ladybug-build.mjs";

const FILES = ["relayer-app-server.exe", "relayer-app-server.pdb", "relayer-graph-server.exe", "relayer-graph-server.pdb"];

export function windowsNativeHandoffContext(contract, environment) {
  if (!contract.release || contract.targetKey !== "windows-x64"
    || !contract.candidateWorkflowRunId || !contract.candidateWorkflowRunAttempt
    || environment.GITHUB_ACTIONS !== "true"
    || environment.GITHUB_RUN_ID !== contract.candidateWorkflowRunId
    || environment.GITHUB_RUN_ATTEMPT !== contract.candidateWorkflowRunAttempt
    || !environment.GITHUB_JOB) {
    throw new Error("Windows native handoff requires the same GitHub candidate job, run, and attempt.");
  }
  return { contract, job: environment.GITHUB_JOB };
}

async function inventory(repositoryRoot, contract) {
  const directory = resolve(repositoryRoot, "target", contract.rustTarget, "release");
  return Promise.all(FILES.map(async name => {
    const path = resolve(directory, name);
    const info = await lstat(path);
    if (!info.isFile() || info.size === 0) throw new Error(`Windows native handoff requires a nonempty regular file: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { name, size: info.size, sha256: hash.digest("hex") };
  }));
}

// This is a same-job handoff, never a cross-run cache or release authority.
export async function writeWindowsNativeHandoff({ contract, environment, repositoryRoot, receiptPath }) {
  const receipt = { schemaVersion: 1, context: windowsNativeHandoffContext(contract, environment), files: await inventory(repositoryRoot, contract) };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return { nativeReceipt: receiptPath };
}

export async function verifyWindowsNativeHandoff({ contract, environment, repositoryRoot, receiptPath,
  requireLicense = requireLadybugDistributionLicenseReady }) {
  const expectedContext = windowsNativeHandoffContext(contract, environment);
  await requireLicense();
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (receipt.schemaVersion !== 1 || JSON.stringify(receipt.context) !== JSON.stringify(expectedContext)
    || JSON.stringify(receipt.files) !== JSON.stringify(await inventory(repositoryRoot, contract))) {
    throw new Error("Windows native handoff differs from the current release contract, job, or EXE/PDB bytes.");
  }
  return null;
}

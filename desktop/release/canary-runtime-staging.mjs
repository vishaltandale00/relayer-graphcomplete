import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { desktopReleaseTarget } from "./contract.mjs";
import { activeProviderRuntimeRequirements, parseUpdateRuntimeRequirements } from "../shared/managed-runtime-requirements.mjs";

export async function waitForCanaryRuntimeStaging({
  profileDirectory, publicationReceiptPath, targetVersion, targetKey, definitions,
  timeoutMs, pollIntervalMs = 500, fetchImpl = fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const target = desktopReleaseTarget(targetKey);
  if (!Array.isArray(definitions) || definitions.some((definition) => definition.connected !== false)) {
    throw new Error("Runtime-staging canary requires an isolated disconnected-provider profile.");
  }
  const receipt = JSON.parse(await readFile(publicationReceiptPath, "utf8"));
  if (receipt.schemaVersion !== 2 || receipt.channel !== "preview" || receipt.target !== targetKey
    || receipt.version !== targetVersion || receipt.manifest?.key !== `${target.publicPrefix}/beta-mac.yml`
    || !/^[a-f0-9]{64}$/.test(receipt.manifest?.sha256 || "") || receipt.manifest.size > 16_384) {
    throw new Error("Runtime-staging canary requires the exact Preview publication receipt.");
  }
  const response = await fetchImpl(`${target.updateBaseUrl}/beta-mac.yml`, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
  });
  if (!response.ok) throw new Error("Runtime-staging Preview manifest is unavailable.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== receipt.manifest.size
    || createHash("sha256").update(bytes).digest("hex") !== receipt.manifest.sha256) {
    throw new Error("Runtime-staging Preview manifest does not match its publication receipt.");
  }
  const manifest = parse(bytes.toString("utf8"));
  if (manifest.version !== targetVersion) throw new Error("Runtime-staging Preview version changed.");
  const incoming = parseUpdateRuntimeRequirements(manifest);
  const requirements = activeProviderRuntimeRequirements(definitions)
    .map(({ runtimeId }) => ({ runtimeId, recipeId: incoming[runtimeId] }));
  console.error(`[desktop-canary] Await staged runtimes: ${requirements.map(({ runtimeId }) => runtimeId).join(",") || "none"}`);
  let previousComplete = false;
  while (Date.now() < deadline) {
    let complete = true;
    for (const { runtimeId, recipeId } of requirements) {
      let pending;
      try {
        pending = JSON.parse(await readFile(join(profileDirectory, "managed-runtimes", ".pending-app-updates",
          targetVersion, `${runtimeId}-${targetKey}.json`), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        complete = false;
        continue;
      }
      if (pending.schemaVersion !== 2 || pending.appVersion !== targetVersion || pending.runtimeId !== runtimeId
        || pending.target !== targetKey || pending.recipeId !== recipeId
        || !/^[a-f0-9-]{36}$/.test(pending.installation || "")) {
        throw new Error(`Staged ${runtimeId} receipt does not match the incoming app update.`);
      }
    }
    const staging = await readdir(join(profileDirectory, "managed-runtimes", ".staging"))
      .catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    if (staging.length > 0) complete = false;
    // The installer writes its receipt before finally removing staging and
    // releasing its operation. Observe two settled filesystem reads before
    // requesting the real restart; never answer or suppress its quit dialog.
    if (complete && previousComplete) return;
    previousComplete = complete;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(pollIntervalMs, deadline - Date.now()))));
  }
  throw new Error("Timed out waiting for managed runtime staging before canary restart.");
}

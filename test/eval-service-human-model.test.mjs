import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { EvalService } from "../desktop/eval-main/eval-service.mjs";

const directories = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it.each([false, true])("retains the human session family across case threads (configuration-owned: %s)", async (configurationOwned) => {
  const directory = await mkdtemp(join(tmpdir(), "human-model-pin-")); directories.push(directory);
  const harnessId = configurationOwned ? "codex-layered-navigation-luna" : "codex-basic";
  const first = { harnessId, familyId: 1, providerId: "work", modelId: "first" };
  const selectModel = vi.fn().mockResolvedValueOnce(configurationOwned ? null : first).mockResolvedValue({ ...first, modelId: "changed" });
  const requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    if (new URL(url).pathname === "/api/model-settings") return Response.json({
      defaults: { harnessId }, providers: [], families: [],
      harnesses: [{ id: harnessId, available: true, modelRules: configurationOwned ? null : { allow: [], deny: [] }, compatibleProviderIds: configurationOwned ? [] : ["work"] }],
    });
    if (new URL(url).pathname === "/api/threads" && options.method === "POST") {
      requests.push(JSON.parse(options.body));
      return Response.json({ id: requests.length, rootInteractionId: requests.length });
    }
    throw new Error(`Unexpected ${url}`);
  }));
  const service = await new EvalService({ stateFile: join(directory, "runs.json"),
    productSession: { origin: "http://product.invalid", cookie: { name: "control", value: "test" } },
    configurationPaths: [resolve("harnesses", `${harnessId}.yaml`)], selectModel, targetKey: "macos-arm64" }).open();
  const prepared = await service.prepareHumanTask({ testCaseId: "empty-project.task-system.two-turn", harnessConfigurationName: harnessId, sessionId: "human" });
  prepared.plan.push({ ...prepared.plan[0], name: "Second case step" });
  await service.createHumanTaskThread(prepared, 0);
  const persisted = structuredClone(prepared);
  await service.createHumanTaskThread(persisted, 1);
  expect(requests).toHaveLength(2);
  expect(requests.map(({ modelSelection }) => modelSelection)).toEqual(configurationOwned ? [undefined, undefined] : [
    { familyId: 1 }, { familyId: 1 },
  ]);
  expect(selectModel).toHaveBeenCalledTimes(configurationOwned ? 0 : 1);
  expect(persisted.execution.modelResolution).toEqual(prepared.execution.pinnedModelResolution);
});

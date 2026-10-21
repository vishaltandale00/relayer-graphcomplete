import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { loadHarnessConfiguration } from "../src/configuration.js";
import { HarnessHost } from "../src/host.js";
import type { HarnessConfiguration, HarnessFactoryContext } from "../src/types.js";

async function configurations(name: string) {
  const current = await loadHarnessConfiguration(fileURLToPath(new URL(`../../../harnesses/${name}.yaml`, import.meta.url)));
  const { instructionGraphVersionKey: _version, instructionGraphDigest: _digest, promptProfile: _profile, ...settings } = current.settings;
  const prior = { ...current, revision: current.revision! - 1, settings };
  return { current, prior };
}

it.each(["claude-basic", "prime-agent-basic"])("upgrades a compatible saved %s registration, persists current identity and reopens", async name => {
  const directory = await mkdtemp(join(tmpdir(), "relayer-instruction-promotion-"));
  const stateFile = join(directory, "sessions.json");
  const { current, prior } = await configurations(name);
  const registration = { threadId: 1, configuration: current, permissionProfileId: "auto", workingDirectory: directory };
  const factory = vi.fn((_context: HarnessFactoryContext) => ({ async complete() {}, state: () => ({}) }));
  const makeHost = () => new HarnessHost({ stateFile, controlToken: "fixture", implementations: { [current.implementation]: factory } });
  let host = makeHost();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await writeFile(stateFile, JSON.stringify({ schemaVersion: 6, sessions: [{ ...registration, configuration: prior, state: { oldSession: "opaque" } }] }));
    await host.initialize();
    await host.createSession(registration);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ configuration: current, savedState: { oldSession: "opaque" } });
    expect(JSON.parse(await readFile(stateFile, "utf8")).sessions).toEqual([{ ...registration, state: {} }]);
    await host.close();
    host = makeHost();
    await host.initialize();
    await host.createSession(registration);
    expect(factory.mock.calls[1]?.[0]).toMatchObject({ configuration: current, savedState: {} });
  } finally { warning.mockRestore(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(["claude-basic", "prime-agent-basic"])("keeps %s instruction promotion narrower than execution or scope changes", async name => {
  const directory = await mkdtemp(join(tmpdir(), "relayer-instruction-promotion-refusal-"));
  const stateFile = join(directory, "sessions.json");
  const { current, prior } = await configurations(name);
  const saved = { threadId: 1, configuration: prior, permissionProfileId: "auto", workingDirectory: directory };
  const changed: HarnessConfiguration[] = [
    { ...current, revision: current.revision! + 1 },
    { ...current, name: `${name}-other` },
    { ...current, settings: { ...current.settings, instructionGraphVersionKey: "codex-instruction-graph-v2" } },
    { ...current, settings: { ...current.settings, instructionGraphDigest: "0".repeat(64) } },
    { ...current, settings: { ...current.settings, unrelatedExecutionSetting: true } },
    { ...current, permissionBindings: { ...current.permissionBindings, auto: current.permissionBindings.full! } },
    { ...current, executionAccessContracts: [] },
    { ...current, complete: { agentAuthored: false } },
    { ...current, graphCapabilityProfile: { ...current.graphCapabilityProfile, search: "disabled" } },
  ];
  try {
    for (const registration of [
      ...changed.map(configuration => ({ ...saved, configuration })),
      { ...saved, configuration: current, permissionProfileId: "full" },
      { ...saved, configuration: current, workingDirectory: join(directory, "other") },
    ]) {
      await writeFile(stateFile, JSON.stringify({ schemaVersion: 6, sessions: [saved] }));
      const factory = vi.fn(() => ({ async complete() {}, state: () => ({}) }));
      const host = new HarnessHost({ stateFile, controlToken: "fixture", implementations: { [current.implementation]: factory } });
      await host.initialize();
      await expect(host.createSession(registration)).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
      await host.close();
    }
    const factory = vi.fn(() => ({ async complete() {}, state: () => ({}) }));
    await writeFile(stateFile, JSON.stringify({ schemaVersion: 6, sessions: [] }));
    const host = new HarnessHost({ stateFile, controlToken: "fixture", implementations: { [current.implementation]: factory } });
    await host.initialize();
    await host.createSession(saved);
    await expect(host.createSession({ ...saved, configuration: current })).rejects.toThrow("already pinned");
    expect(factory).toHaveBeenCalledTimes(1);
    await host.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

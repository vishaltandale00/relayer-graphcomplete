import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PrimeAgentHarness } from "../src/implementations/prime-agent.js";
import { createNoopHarnessTraceSink } from "../src/trace.js";
import type { HarnessConfiguration, HarnessRunContext } from "../src/types.js";

// PPG-003 with the real Prime SDK and no inference: every run, root or invoked child, gets a
// new native session built with its own interaction's native presentation instructions.
// The turns carry no admitted model family, so each one stops right after its session
// is acquired, before any prompt or provider request.

const configuration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "prime-agent-basic",
  implementation: "prime.agent",
  implementationVersion: 1,
  permissionBindings: { full: {} },
  settings: { prewarmIpythonKernel: false },
};
const marker = "If you are the root agent";

it("builds each new Prime session with its own interaction's native presentation instructions", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "prime-native-instructions-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PRIME_AGENT_TELEMETRY", "0");
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const native = await import("@earendil-works/pi-coding-agent");
  type NativeSession = Awaited<ReturnType<typeof native.createAgentSessionFromServices>>["session"];
  const sessions: NativeSession[] = [];
  const harness = await PrimeAgentHarness.create({
    threadId: 1, workingDirectory: workspace, permissionProfileId: "full", permissionBinding: {}, configuration,
  }, { loadModule: async () => ({
    ...native,
    createAgentSessionServices: (options: Parameters<typeof native.createAgentSessionServices>[0]) => native.createAgentSessionServices({
      ...options,
      agentDir: join(home, "agent"),
      authStorage: native.AuthStorage.inMemory(),
      settingsManager: native.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { ...options.resourceLoaderOptions, noExtensions: true, noSkills: true, noPromptTemplates: true },
    }),
    createAgentSessionFromServices: async (options: Parameters<typeof native.createAgentSessionFromServices>[0]) => {
      const result = await native.createAgentSessionFromServices({ ...options, tools: [], prewarmIpythonKernel: false });
      sessions.push(result.session);
      return result;
    },
  }) as never });
  const acquire = (context: HarnessRunContext) => expect(harness.complete(context)).rejects.toThrow("admitted model family");
  const instructed = (session: NativeSession | undefined) => session!.systemPrompt.includes(marker);
  try {
    // Creating the harness creates no session (#719): each run creates its own.
    expect(sessions).toHaveLength(0);
    await acquire(turn(1, "root", false));
    await acquire(turn(2, "root", true));
    // Invoked children are built from their own pins, not from whatever another run saw.
    await acquire(turn(3, "invoke", true));
    await acquire(turn(4, "invoke", false));
    // A root run never inherits an earlier root run's session or guidance.
    await acquire(turn(5, "root", true));
    await acquire(turn(6, "root", false));
    expect(sessions.map(instructed)).toEqual([false, true, true, false, true, false]);
  } finally {
    await harness.dispose().catch(() => undefined);
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

function turn(nodeId: number, origin: "root" | "invoke", pinned: boolean): HarnessRunContext {
  const inputGraph = { id: nodeId, kind: "user-interaction", icon: "user", title: "Q", detail: "Q", state: "accepted" as const };
  return {
    origin: origin === "root" ? { kind: "root" } : { kind: "invoke", sourceCompletionId: 2, actionId: 100 + nodeId },
    inputGraph,
    interactionInput: { interaction: inputGraph, contexts: [] },
    graph: { interactionNodeId: nodeId, acquireCapability: () => ({ url: "http://127.0.0.1:1", token: `token-${nodeId}`, nodeId }) },
    trace: createNoopHarnessTraceSink(),
    approvals: { request: async () => { throw new Error("unused approval channel"); } },
    ...(pinned ? { personalPresentation: {
      attachment: { interactionNodeId: nodeId, versionInteractionNodeId: 90, rootLayerId: 91 },
      graph: {
        nodeId: 90,
        rootLayerId: 91,
        rootAction: { id: 92, sourceNodeId: 90, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: 91, state: "accepted" },
        layers: [{
          layer: { id: 91, nodes: [93], edges: [], state: "accepted" },
          nodes: [{ id: 93, kind: "presentation-preference", icon: "compass", title: "Decision-useful center", detail: "Foreground the conclusion.", state: "accepted" }],
          edges: [],
          actions: [],
        }],
      },
    } } : {}),
  } as HarnessRunContext;
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessHost } from "../src/host.js";
import { loadHarnessConfiguration } from "../src/configuration.js";
import type { CodexAppServerTurnOptions } from "../src/implementations/codex-app-server.js";
import { CodexBasicHarness } from "../src/implementations/codex-basic.js";

// A thread saved by a release that resumed its root conversation (#719 retired that resume).
afterEach(() => vi.unstubAllGlobals());

describe("legacy Codex host registration", () => {
  it.each([false, true])("registers a thread with legacy saved state and runs its next root turn fresh (malformed pin=%s)", async (malformed) => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-legacy-host-"));
    const stateFile = join(directory, "sessions.json");
    const configuration = await loadHarnessConfiguration(fileURLToPath(new URL("../../../harnesses/codex-basic.yaml", import.meta.url)));
    const registration = { threadId: 1, permissionProfileId: "auto" as const, configuration, workingDirectory: directory };
    const state = { codexThreadId: "legacy-thread", ...(malformed ? { codexThreadPersonalPresentationVersionId: "invalid-pin" } : {}) };
    let accepted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith("/output")) return accepted
        ? json({ nodeId: 1, rootAction: null, rootLayer: { layer: { id: 3, nodes: [], edges: [], state: "accepted" }, nodes: [], edges: [], actions: [] } })
        : json({ error: { code: "completion_not_found" } }, 404);
      if (url.endsWith("/personal-presentation")) return json({ error: { code: "personal_presentation_not_attached" } }, 404);
      const node = { id: 1, kind: "user-interaction", icon: "user", title: "Q", detail: "Q", state: "accepted" };
      return json(url.endsWith("/input") ? { interaction: node, contexts: [] } : { node });
    }));
    const submissions: CodexAppServerTurnOptions[] = [];
    const host = new HarnessHost({ stateFile, controlToken: "fixture-control", implementations: {
      "codex.basic": (context) => new CodexBasicHarness(context, {
        codexPathOverride: "/managed/codex",
        runAppServerTurn: async (options) => {
          submissions.push(options);
          accepted = true;
          return { threadId: "fresh-thread", turnId: "turn-1", status: "completed" };
        },
      }),
    } });
    try {
      await writeFile(stateFile, JSON.stringify({ schemaVersion: 6, sessions: [{ ...registration, state }] }));
      await host.initialize();
      await host.createSession(registration);
      expect(submissions).toHaveLength(0);

      await host.complete(1, 1, { url: "http://127.0.0.1:43123", token: "token", nodeId: 1 });

      expect(submissions).toHaveLength(1);
      expect("savedThreadId" in submissions[0]!).toBe(false);
      expect(JSON.parse(await readFile(stateFile, "utf8")).sessions[0].state).toEqual({});
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

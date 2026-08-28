import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthenticatedErrorGateway } from "../desktop/main/services/authenticated-error-gateway.mjs";

const directories = [];

async function fixture({
  send = vi.fn(async () => {}),
  enable = vi.fn(async () => {}),
  disable = vi.fn(async () => {}),
  now = () => Date.UTC(2026, 7, 28),
  encrypt = async (plaintext) => Buffer.from(`sealed:${plaintext}`).toString("base64"),
  decrypt = async (sealed) => {
    const plaintext = Buffer.from(sealed, "base64").toString("utf8");
    if (!plaintext.startsWith("sealed:")) throw new Error("invalid fixture ciphertext");
    return plaintext.slice(7);
  },
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relayer-authenticated-errors-"));
  directories.push(directory);
  const queuePath = join(directory, "queue.json");
  const gateway = createAuthenticatedErrorGateway({
    queuePath,
    encrypt,
    decrypt,
    transport: { enable, disable, send },
    release: "ai.relayer.desktop@0.2.16+fixture",
    environment: "preview",
    os: "darwin",
    architecture: "arm64",
    now,
  });
  return { gateway, queuePath, send, enable, disable, decrypt };
}

async function queuedRecords(queuePath, decrypt) {
  const envelope = JSON.parse(await readFile(queuePath, "utf8"));
  return JSON.parse(await decrypt(envelope.sealed)).records;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("authenticated desktop error gateway", () => {
  it("admits a closed record only for a verified generation and injects the domain-separated pseudonym", async () => {
    const { gateway, send, enable, disable } = await fixture();

    expect(gateway.issueReporter({ component: "renderer", processGeneration: 1 })).toBeNull();
    expect(enable).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    await gateway.transitionIdentity({ generation: 4, subject: "auth0|person" });
    const reporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    await expect(reporter.report({
      code: "renderer.unhandled_crash",
      exceptionClass: "TypeError",
      frames: [{ module: "desktop/renderer/src/main.js", line: 41, column: 9 }],
    })).resolves.toEqual({ accepted: true, delivery: "sent" });

    const pseudonym = createHash("sha256")
      .update("graphcomplete-sentry-user-v1\0", "utf8")
      .update("auth0|person", "utf8")
      .digest("hex");
    expect(enable).toHaveBeenCalledWith({
      user: { id: pseudonym },
      release: "ai.relayer.desktop@0.2.16+fixture",
      environment: "preview",
      os: "darwin",
      architecture: "arm64",
    });
    expect(send).toHaveBeenCalledWith({
      user: { id: pseudonym },
      release: "ai.relayer.desktop@0.2.16+fixture",
      environment: "preview",
      os: "darwin",
      architecture: "arm64",
      component: "renderer",
      operation: "unhandled-crash",
      code: "renderer.unhandled_crash",
      message: "Renderer process crashed unexpectedly.",
      exceptionClass: "TypeError",
      frames: [{ module: "desktop/renderer/src/main.js", line: 41, column: 9 }],
    });

    await gateway.transitionIdentity(null);
    expect(disable).toHaveBeenCalledTimes(2);
    await gateway.close();
  });

  it("queues an authenticated transport failure without exposing plaintext", async () => {
    const send = vi.fn(async () => { throw new Error("capture sink unavailable"); });
    const { gateway, queuePath } = await fixture({ send });
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|queued-person" });
    const reporter = gateway.issueReporter({ component: "electron-main", processGeneration: 3 });

    await expect(reporter.report({
      code: "electron_main.unhandled_crash",
      exceptionClass: "Error",
      frames: [{ module: "desktop/main/index.mjs", line: 413, column: 8 }],
    })).resolves.toEqual({ accepted: true, delivery: "queued" });

    const envelope = await readFile(queuePath, "utf8");
    expect(envelope).not.toContain("queued-person");
    expect(envelope).not.toContain("Electron main process crashed unexpectedly.");
    expect(send).toHaveBeenCalledTimes(1);
    await gateway.close();
  });

  it("invalidates reporters on account-generation change and process restart", async () => {
    const { gateway, send } = await fixture();
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|person" });
    const accountStale = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    await gateway.transitionIdentity({ generation: 2, subject: "auth0|person" });
    await expect(accountStale.report({
      code: "renderer.unhandled_crash", exceptionClass: null, frames: [],
    })).resolves.toEqual({ accepted: false, reason: "stale-capability" });

    const processStale = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    gateway.issueReporter({ component: "renderer", processGeneration: 2 });
    await expect(processStale.report({
      code: "renderer.unhandled_crash", exceptionClass: null, frames: [],
    })).resolves.toEqual({ accepted: false, reason: "stale-capability" });
    expect(send).not.toHaveBeenCalled();
    await gateway.close();
  });

  it("rejects process-generation rollback instead of invalidating the current reporter", async () => {
    const { gateway, send } = await fixture();
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|person" });
    const current = gateway.issueReporter({ component: "renderer", processGeneration: 2 });

    expect(() => gateway.issueReporter({ component: "renderer", processGeneration: 1 }))
      .toThrow("generation is stale");
    await expect(current.report({
      code: "renderer.unhandled_crash", exceptionClass: null, frames: [],
    })).resolves.toEqual({ accepted: true, delivery: "sent" });
    expect(send).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it("rejects extra fields, raw privacy material, and non-application frames before transport or persistence", async () => {
    const privacy = JSON.parse(await readFile(new URL("./fixtures/telemetry-privacy-v1.json", import.meta.url), "utf8"));
    expect(privacy.schema).toBe("relayer.telemetry-privacy-corpus/v1");
    const { gateway, queuePath, send } = await fixture();
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|person" });
    const reporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    const base = { code: "renderer.unhandled_crash", exceptionClass: "Error", frames: [] };

    for (const forbidden of privacy.forbiddenCases) {
      let record = { ...base, [forbidden.field]: structuredClone(forbidden.value) };
      if (forbidden.kind === "frame-module") {
        record = { ...base, frames: [{ module: forbidden.value, line: 1, column: 1 }] };
      } else if (forbidden.kind === "oversized-frames") {
        record = { ...base, frames: Array.from({ length: 33 }, () => ({
          module: "desktop/renderer/src/main.js", line: 1, column: 1,
        })) };
      } else if (forbidden.kind === "oversized-module") {
        record = { ...base, frames: [{
          module: `desktop/renderer/${"x".repeat(257)}.js`, line: 1, column: 1,
        }] };
      }
      await expect(reporter.report(record)).resolves.toEqual({ accepted: false, reason: "invalid-record" });
    }

    expect(send).not.toHaveBeenCalled();
    await expect(access(queuePath)).rejects.toMatchObject({ code: "ENOENT" });
    await gateway.close();
  });

  it("flushes only a fresh same-subject queue and deletes another account or corrupt queue", async () => {
    let currentTime = Date.UTC(2026, 7, 28);
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const { gateway, queuePath } = await fixture({ send, now: () => currentTime });
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|same" });
    const reporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    await reporter.report({ code: "renderer.unhandled_crash", exceptionClass: null, frames: [] });
    await gateway.transitionIdentity(null);
    await gateway.transitionIdentity({ generation: 2, subject: "auth0|same" });
    expect(send).toHaveBeenCalledTimes(2);
    await expect(access(queuePath)).rejects.toMatchObject({ code: "ENOENT" });

    send.mockRejectedValueOnce(new Error("offline again"));
    const replacementReporter = gateway.issueReporter({ component: "renderer", processGeneration: 2 });
    await replacementReporter.report({ code: "renderer.unhandled_crash", exceptionClass: null, frames: [] });
    await gateway.transitionIdentity(null);
    await gateway.transitionIdentity({ generation: 3, subject: "auth0|different" });
    await expect(access(queuePath)).rejects.toMatchObject({ code: "ENOENT" });

    await gateway.transitionIdentity(null);
    await writeFile(queuePath, "not-json", "utf8");
    await gateway.transitionIdentity({ generation: 4, subject: "auth0|different" });
    await expect(access(queuePath)).rejects.toMatchObject({ code: "ENOENT" });

    currentTime += 8 * 24 * 60 * 60 * 1_000;
    await gateway.close();
  });

  it("bounds the encrypted queue to 32 records and evicts oldest records", async () => {
    const send = vi.fn(async () => { throw new Error("offline"); });
    const { gateway, queuePath, decrypt } = await fixture({ send });
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|bounded" });
    const reporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    for (let index = 1; index <= 35; index += 1) {
      await reporter.report({
        code: "renderer.unhandled_crash",
        exceptionClass: null,
        frames: [{ module: "desktop/renderer/src/main.js", line: index, column: 1 }],
      });
    }
    const records = await queuedRecords(queuePath, decrypt);
    expect(records).toHaveLength(32);
    expect(records[0].event.frames[0].line).toBe(4);
    expect(records.at(-1).event.frames[0].line).toBe(35);
    expect(Buffer.byteLength(JSON.parse(await readFile(queuePath, "utf8")).sealed, "utf8")).toBeLessThanOrEqual(256 * 1024);
    await gateway.close();
  });

  it("expires queued records after seven days and purges immediately on retirement", async () => {
    let currentTime = Date.UTC(2026, 7, 28);
    const send = vi.fn(async () => { throw new Error("offline"); });
    const { gateway, queuePath } = await fixture({ send, now: () => currentTime });
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|person" });
    let reporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    await reporter.report({ code: "renderer.unhandled_crash", exceptionClass: null, frames: [] });
    await gateway.transitionIdentity(null);
    currentTime += 7 * 24 * 60 * 60 * 1_000 + 1;
    send.mockResolvedValue(undefined);
    await gateway.transitionIdentity({ generation: 2, subject: "auth0|person" });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(access(queuePath)).rejects.toMatchObject({ code: "ENOENT" });

    send.mockRejectedValueOnce(new Error("offline"));
    reporter = gateway.issueReporter({ component: "renderer", processGeneration: 2 });
    await reporter.report({ code: "renderer.unhandled_crash", exceptionClass: null, frames: [] });
    await gateway.retireIdentity();
    await expect(access(queuePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(reporter.report({
      code: "renderer.unhandled_crash", exceptionClass: null, frames: [],
    })).resolves.toEqual({ accepted: false, reason: "stale-capability" });
    await gateway.close();
  });

  it("accepts only the code-owned V1 event for each component domain", async () => {
    const { gateway, send } = await fixture();
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|person" });
    const fixtures = [
      ["renderer", "renderer.unhandled_crash", "desktop/renderer/src/main.js"],
      ["electron-main", "electron_main.unhandled_crash", "desktop/main/index.mjs"],
      ["node-harness-host", "node_harness_host.unhandled_crash", "packages/harness-host/dist/host.js"],
      ["rust-app-server", "rust_app_server.unexpected_exit", "crates/relayer-app-server/src/main.rs"],
      ["rust-graph-server", "rust_graph_server.startup_failure", "crates/relayer-graph-server/src/main.rs"],
    ];
    let processGeneration = 0;
    for (const [component, code, module] of fixtures) {
      processGeneration += 1;
      const reporter = gateway.issueReporter({ component, processGeneration });
      await expect(reporter.report({
        code, exceptionClass: null, frames: [{ module, line: 1, column: 1 }],
      })).resolves.toEqual({ accepted: true, delivery: "sent" });
    }
    expect(send).toHaveBeenCalledTimes(5);
    await gateway.close();
  });

  it("ignores a stale identity transition without reviving stale authority", async () => {
    const { gateway, send } = await fixture();
    await gateway.transitionIdentity({ generation: 2, subject: "auth0|current" });
    const reporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|stale" });
    await expect(reporter.report({
      code: "renderer.unhandled_crash", exceptionClass: null, frames: [],
    })).resolves.toEqual({ accepted: true, delivery: "sent" });
    expect(send.mock.calls[0][0].user.id).toBe(createHash("sha256")
      .update("graphcomplete-sentry-user-v1\0auth0|current", "utf8").digest("hex"));
    await gateway.close();
  });

  it("rotates main-owned Preview to Stable environment without changing release or preserving reporter authority", async () => {
    const { gateway, enable, disable, send } = await fixture();
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|person" });
    const previewReporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    await gateway.updateEnvironment("stable");
    await expect(previewReporter.report({
      code: "renderer.unhandled_crash", exceptionClass: null, frames: [],
    })).resolves.toEqual({ accepted: false, reason: "stale-capability" });
    const stableReporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    await stableReporter.report({ code: "renderer.unhandled_crash", exceptionClass: null, frames: [] });

    expect(disable).toHaveBeenCalledTimes(2);
    expect(enable).toHaveBeenLastCalledWith(expect.objectContaining({
      release: "ai.relayer.desktop@0.2.16+fixture",
      environment: "stable",
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      release: "ai.relayer.desktop@0.2.16+fixture",
      environment: "stable",
    }));
    await gateway.close();
  });

  it("contains transport and queue failures without recursive reporting", async () => {
    const send = vi.fn(async () => { throw new Error("transport failure"); });
    const encrypt = vi.fn(async () => { throw new Error("storage failure"); });
    const { gateway, queuePath } = await fixture({ send, encrypt });
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|person" });
    const reporter = gateway.issueReporter({ component: "electron-main", processGeneration: 1 });
    await expect(reporter.report({
      code: "electron_main.unhandled_crash", exceptionClass: null, frames: [],
    })).resolves.toEqual({ accepted: true, delivery: "dropped" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(encrypt).toHaveBeenCalledTimes(1);
    await expect(access(queuePath)).rejects.toMatchObject({ code: "ENOENT" });
    await gateway.close();
  });
});

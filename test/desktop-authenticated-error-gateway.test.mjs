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

function pseudonymFor(subject) {
  return createHash("sha256")
    .update("graphcomplete-sentry-user-v1\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("authenticated desktop error gateway", () => {
  it("admits closed records only under verified, domain-separated authority", async () => {
    const { gateway, send, enable, disable } = await fixture();
    const closedRecord = { code: "renderer.unhandled_crash", exceptionClass: null, frames: [] };

    expect(gateway.issueReporter({ component: "renderer", processGeneration: 1 }),
      "no reporter exists before any verified identity").toBeNull();
    expect(enable, "transport stays disabled before verification").not.toHaveBeenCalled();
    expect(send, "nothing is sent before verification").not.toHaveBeenCalled();

    await gateway.transitionIdentity({ generation: 4, subject: "auth0|person" });
    const firstReporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    await expect(firstReporter.report({
      code: "renderer.unhandled_crash",
      exceptionClass: "TypeError",
      frames: [{ module: "desktop/renderer/src/main.js", line: 41, column: 9 }],
    }), "first closed record under a verified identity").resolves.toEqual({ accepted: true, delivery: "sent" });

    const firstProjection = {
      user: { id: pseudonymFor("auth0|person") },
      release: "ai.relayer.desktop@0.2.16+fixture",
      environment: "preview",
      os: "darwin",
      architecture: "arm64",
    };
    expect(enable, "transport enabled with the domain-separated pseudonym").toHaveBeenCalledWith(firstProjection);
    expect(send, "sent event carries pseudonym, identity, and the closed V1 event").toHaveBeenCalledWith({
      ...firstProjection,
      component: "renderer",
      operation: "unhandled-crash",
      code: "renderer.unhandled_crash",
      message: "Renderer process crashed unexpectedly.",
      exceptionClass: "TypeError",
      frames: [{ module: "desktop/renderer/src/main.js", line: 41, column: 9 }],
    });

    const componentDomains = [
      ["renderer admits its V1 crash event", "renderer", "renderer.unhandled_crash", "desktop/renderer/src/main.js"],
      ["electron-main admits its V1 crash event", "electron-main", "electron_main.unhandled_crash", "desktop/main/index.mjs"],
      ["node-harness-host admits its V1 crash event", "node-harness-host", "node_harness_host.unhandled_crash", "packages/harness-host/dist/host.js"],
      ["rust-app-server admits its V1 exit event", "rust-app-server", "rust_app_server.unexpected_exit", "crates/relayer-app-server/src/main.rs"],
      ["rust-graph-server admits its V1 startup event", "rust-graph-server", "rust_graph_server.startup_failure", "crates/relayer-graph-server/src/main.rs"],
    ];
    expect(componentDomains, "component domain inventory").toHaveLength(5);
    let processGeneration = 1;
    let lastDomainReporter = null;
    for (const [label, component, code, module] of componentDomains) {
      processGeneration += 1;
      lastDomainReporter = gateway.issueReporter({ component, processGeneration });
      await expect(lastDomainReporter.report({
        code, exceptionClass: null, frames: [{ module, line: 1, column: 1 }],
      }), label).resolves.toEqual({ accepted: true, delivery: "sent" });
    }
    expect(send, "every component domain sent exactly one V1 event").toHaveBeenCalledTimes(6);

    await gateway.updateEnvironment("stable");
    await expect(lastDomainReporter.report(closedRecord),
      "environment rotation revokes reporters issued under preview").resolves.toEqual({ accepted: false, reason: "stale-capability" });
    const stableReporter = gateway.issueReporter({ component: "renderer", processGeneration: 3 });
    await expect(stableReporter.report(closedRecord),
      "reissued reporter sends under the rotated environment").resolves.toEqual({ accepted: true, delivery: "sent" });
    expect(enable, "rotation re-enables transport with the same release and the stable environment").toHaveBeenLastCalledWith(expect.objectContaining({
      release: "ai.relayer.desktop@0.2.16+fixture",
      environment: "stable",
    }));
    expect(send, "rotated send keeps the release and reports the stable environment").toHaveBeenLastCalledWith(expect.objectContaining({
      release: "ai.relayer.desktop@0.2.16+fixture",
      environment: "stable",
    }));

    await gateway.transitionIdentity({ generation: 5, subject: "auth0|other-person" });
    await expect(stableReporter.report(closedRecord),
      "account-generation change invalidates the prior reporter").resolves.toEqual({ accepted: false, reason: "stale-capability" });
    const generationStale = gateway.issueReporter({ component: "renderer", processGeneration: 4 });
    const currentReporter = gateway.issueReporter({ component: "renderer", processGeneration: 5 });
    await expect(generationStale.report(closedRecord),
      "process restart invalidates superseded process reporters").resolves.toEqual({ accepted: false, reason: "stale-capability" });
    expect(send, "stale reporters never reach transport").toHaveBeenCalledTimes(7);

    expect(() => gateway.issueReporter({ component: "renderer", processGeneration: 4 }),
      "process-generation rollback is rejected instead of invalidating the current reporter")
      .toThrow("generation is stale");
    await expect(currentReporter.report(closedRecord),
      "current reporter keeps sending after a rejected rollback").resolves.toEqual({ accepted: true, delivery: "sent" });

    await gateway.transitionIdentity({ generation: 1, subject: "auth0|stale" });
    await expect(currentReporter.report(closedRecord),
      "stale identity transition is ignored and current authority survives").resolves.toEqual({ accepted: true, delivery: "sent" });
    expect(send.mock.calls.at(-1)[0].user.id,
      "surviving authority keeps its own pseudonym after the ignored transition").toBe(pseudonymFor("auth0|other-person"));
    expect(send, "full lifecycle sent exactly the admitted records").toHaveBeenCalledTimes(9);

    const disableCallsBeforeSignOut = disable.mock.calls.length;
    await gateway.transitionIdentity(null);
    await expect(currentReporter.report(closedRecord),
      "sign-out revokes every issued reporter").resolves.toEqual({ accepted: false, reason: "stale-capability" });
    expect(disable.mock.calls.length, "sign-out disables transport").toBeGreaterThan(disableCallsBeforeSignOut);

    await gateway.close();
  }, 15_000);

  it("rejects the complete invalid-record corpus before transport or persistence", async () => {
    const privacy = JSON.parse(await readFile(new URL("./fixtures/telemetry-privacy-v1.json", import.meta.url), "utf8"));
    expect(privacy.schema, "privacy corpus schema pin").toBe("relayer.telemetry-privacy-corpus/v1");
    const { gateway, queuePath, send } = await fixture();
    await gateway.transitionIdentity({ generation: 1, subject: "auth0|person" });
    const reporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    const base = { code: "renderer.unhandled_crash", exceptionClass: "Error", frames: [] };

    const cases = [
      ["frame line beyond the accepted source range", { ...base, frames: [{ module: "desktop/renderer/src/main.js", line: 10_000_001, column: 9 }] }],
      ["frame column beyond the accepted source range", { ...base, frames: [{ module: "desktop/renderer/src/main.js", line: 41, column: 10_000_001 }] }],
      ["frame position beyond safe-integer range", { ...base, frames: [{ module: "desktop/renderer/src/main.js", line: Number.MAX_SAFE_INTEGER, column: 9 }] }],
      ["single key impersonating the closed field set", JSON.parse('{"code\\u0000exceptionClass\\u0000frames": "renderer.unhandled_crash"}')],
    ];
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
      cases.push([`privacy:${forbidden.id}`, record]);
    }
    expect(cases, "invalid-record corpus inventory").toHaveLength(37);

    for (const [label, record] of cases) {
      await expect.soft(reporter.report(record), label).resolves.toEqual({ accepted: false, reason: "invalid-record" });
    }
    expect(send, "no rejected record reached transport").not.toHaveBeenCalled();
    await expect(access(queuePath), "no rejected record reached the encrypted queue").rejects.toMatchObject({ code: "ENOENT" });

    await expect(reporter.report({
      code: "renderer.unhandled_crash",
      exceptionClass: "Error",
      frames: [{ module: "desktop/renderer/src/main.js", line: 10_000_000, column: 10_000_000 }],
    }), "positions exactly at the accepted bound are admitted").resolves.toEqual({ accepted: true, delivery: "sent" });
    await gateway.close();
  }, 15_000);

  it("bounds the encrypted queue lifecycle", async () => {
    let currentTime = Date.UTC(2026, 7, 28);
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const { gateway, queuePath, decrypt } = await fixture({ send, now: () => currentTime });
    const closedRecord = { code: "renderer.unhandled_crash", exceptionClass: null, frames: [] };

    await gateway.transitionIdentity({ generation: 1, subject: "auth0|same" });
    const firstReporter = gateway.issueReporter({ component: "renderer", processGeneration: 1 });
    await expect(firstReporter.report({
      code: "renderer.unhandled_crash",
      exceptionClass: null,
      frames: [{ module: "desktop/renderer/src/main.js", line: 1, column: 1 }],
    }), "transport failure is accepted and queued").resolves.toEqual({ accepted: true, delivery: "queued" });
    const sealedEnvelope = await readFile(queuePath, "utf8");
    expect(sealedEnvelope, "queued envelope hides the account subject").not.toContain("auth0|same");
    expect(sealedEnvelope, "queued envelope hides product message plaintext").not.toContain("Renderer process crashed unexpectedly.");
    expect(send, "the failed send was attempted exactly once").toHaveBeenCalledTimes(1);

    await gateway.transitionIdentity(null);
    await gateway.transitionIdentity({ generation: 2, subject: "auth0|same" });
    expect(send, "reverification of the same subject flushes the fresh queue").toHaveBeenCalledTimes(2);
    await expect(access(queuePath), "flushed queue file is removed").rejects.toMatchObject({ code: "ENOENT" });

    send.mockRejectedValueOnce(new Error("offline again"));
    const secondReporter = gateway.issueReporter({ component: "renderer", processGeneration: 2 });
    await secondReporter.report(closedRecord);
    await gateway.transitionIdentity(null);
    await gateway.transitionIdentity({ generation: 3, subject: "auth0|different" });
    expect(send, "another account never flushes the prior queue").toHaveBeenCalledTimes(3);
    await expect(access(queuePath), "another account deletes the queued records").rejects.toMatchObject({ code: "ENOENT" });

    await gateway.transitionIdentity(null);
    await writeFile(queuePath, "not-json", "utf8");
    await gateway.transitionIdentity({ generation: 4, subject: "auth0|different" });
    expect(send, "a corrupt queue is never flushed").toHaveBeenCalledTimes(3);
    await expect(access(queuePath), "corrupt queue file is deleted").rejects.toMatchObject({ code: "ENOENT" });

    await gateway.transitionIdentity({ generation: 5, subject: "auth0|bounded" });
    send.mockRejectedValue(new Error("offline"));
    const boundedReporter = gateway.issueReporter({ component: "electron-main", processGeneration: 1 });
    for (let index = 1; index <= 35; index += 1) {
      await boundedReporter.report({
        code: "electron_main.unhandled_crash",
        exceptionClass: null,
        frames: [{ module: "desktop/main/index.mjs", line: index, column: 1 }],
      });
    }
    const records = await queuedRecords(queuePath, decrypt);
    expect(records, "queue is bounded to 32 records").toHaveLength(32);
    expect(records[0].event.frames[0].line, "oldest records are evicted first").toBe(4);
    expect(records.at(-1).event.frames[0].line, "newest record survives eviction").toBe(35);
    expect(Buffer.byteLength(JSON.parse(await readFile(queuePath, "utf8")).sealed, "utf8"),
      "sealed queue stays within the byte bound").toBeLessThanOrEqual(256 * 1024);

    await gateway.transitionIdentity(null);
    currentTime += 7 * 24 * 60 * 60 * 1_000 + 1;
    send.mockReset().mockResolvedValue(undefined);
    await gateway.transitionIdentity({ generation: 6, subject: "auth0|bounded" });
    expect(send, "records older than seven days expire instead of flushing").toHaveBeenCalledTimes(0);
    await expect(access(queuePath), "expired queue file is removed").rejects.toMatchObject({ code: "ENOENT" });

    send.mockRejectedValueOnce(new Error("offline"));
    const finalReporter = gateway.issueReporter({ component: "renderer", processGeneration: 2 });
    await expect(finalReporter.report(closedRecord),
      "post-expiry transport failure requeues instead of dropping").resolves.toEqual({ accepted: true, delivery: "queued" });
    await gateway.retireIdentity();
    await expect(access(queuePath), "retirement purges the queue immediately").rejects.toMatchObject({ code: "ENOENT" });
    await expect(finalReporter.report(closedRecord),
      "retirement invalidates every issued reporter").resolves.toEqual({ accepted: false, reason: "stale-capability" });
    expect(send, "only the post-expiry record attempted delivery before retirement purged the queue").toHaveBeenCalledTimes(1);

    await gateway.close();
  }, 20_000);
});

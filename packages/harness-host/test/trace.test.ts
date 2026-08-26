import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { renameSync, symlinkSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml, parseAllDocuments } from "yaml";
import { HarnessTraceStore, NO_HARNESS_TRACE_SUPPORT, redactTraceData } from "../src/trace.js";
import type { HarnessTracePolicy, HarnessTraceSupport } from "../src/types.js";

const fullSupport: HarnessTraceSupport = {
  prompt: "full",
  messages: "full",
  reasoningSummaries: "summary",
  modelCalls: "full",
  toolCalls: "full",
  usage: "full",
  childStreams: "summary",
  nativeArtifacts: "none",
};

const policy = (overrides: Partial<HarnessTracePolicy> = {}): HarnessTracePolicy => ({
  mode: "required",
  requiredFeatures: {},
  includeNativeArtifacts: false,
  maxBytesPerTurn: 1_000_000,
  maxEventsPerTurn: 1_000,
  ...overrides,
});

function sealFixtureTrace(store: HarnessTraceStore): Promise<unknown> {
  return store.start({
    threadId: 1,
    interactionNodeId: 2,
    productInteractionId: 3,
    implementation: "fixture.trace",
    configurationName: "fixture-trace",
    support: fullSupport,
  }).seal("complete");
}

describe("HarnessTraceStore", () => {
  it("rejects unsupported required coverage before a trace starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-preflight-"));
    const spool = join(directory, "spool");
    const abandoned = join(spool, "abandoned-before-preflight.txt");
    try {
      await mkdir(spool, { mode: 0o700 });
      await writeFile(abandoned, "must be cleaned before teardown completes\n");
      const store = new HarnessTraceStore({
        directory: spool,
        policy: policy({ requiredFeatures: { modelCalls: "full" } }),
      });
      expect(() => store.start({
        threadId: 1,
        interactionNodeId: 2,
        productInteractionId: 3,
        implementation: "fixture.none",
        configurationName: "fixture-none",
        support: NO_HARNESS_TRACE_SUPPORT,
      })).toThrow("before inference");

      await store.close();
      await expect(readFile(abandoned, "utf8")).rejects.toThrow();
      await writeFile(join(spool, "post-close-sentinel.txt"), "survives\n");
      await Promise.resolve();
      await expect(readFile(join(spool, "post-close-sentinel.txt"), "utf8")).resolves.toBe("survives\n");
      expect(() => store.start({
        threadId: 1,
        interactionNodeId: 2,
        implementation: "fixture.none",
        configurationName: "fixture-none",
        support: NO_HARNESS_TRACE_SUPPORT,
      })).toThrow("trace store is closed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("seals nested portable events, redacts secrets, and exports exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-store-"));
    const target = join(directory, "exported", "candidate-trace");
    try {
      let nextId = 0;
      const store = new HarnessTraceStore({ directory: join(directory, "spool"), policy: policy(), createId: () => `id-${++nextId}` });
      const active = store.start({
        threadId: 1,
        interactionNodeId: 2,
        productInteractionId: 3,
        implementation: "fixture.trace",
        configurationName: "fixture-trace",
        support: fullSupport,
      });
      active.sink.emit({
        type: "prompt",
        data: {
          text: `Open /Users/private-user/project, C:\\Users\\private-user\\project, D:\\Users\\private-user\\project, C:/Users/private-user/project, file:///D:/Users/private-user/project, ${join(homedir(), "private-project")}, and /private/var/folders/xy/private-token/T/project. Keep the root layer, https://api.example/home/products, and /home/products semantic.\n-rw-r--r--  1 ${basename(homedir())} staff 42 note.txt\nuid=501(${basename(homedir())}) gid=20(staff)\n${basename(homedir())}@${hostname()}\n${hostname()}\nGITHUB_TOKEN=ghp_private\nexport GITHUB_TOKEN=\"exported-private\"\ndeclare -x AWS_SECRET_ACCESS_KEY='declared-private'\nDATABASE_URL=postgres://alice:live-password@db.example/app\nAWS_SECRET_ACCESS_KEY=private-aws\nNPM_TOKEN=private-npm\nclientSecret=private-client\nclientKey=semantic-client-key\nAuthorization: Basic private-basic\n{\"clientSecret\":\"serialized-json-private\"}\nclientSecret: |\n  yaml-block-private\n  second-private-line\n- clientSecret: |\n    sequence-private\n\"privateKey\": >\n  quoted-private\nsemantic: retained\n-----BEGIN PRIVATE KEY-----\ntruncated-pem-private`,
          authorization: "Bearer secret-token",
          GITHUB_TOKEN: "object-ghp-private",
          AWS_SECRET_ACCESS_KEY: "object-aws-private",
          githubToken: "camel-token-private",
          clientSecret: "camel-secret-private",
          privateKey: "camel-key-private",
          "x-api-key": "header-key-private",
          clientKey: "semantic-client-key",
          primaryKey: "semantic-primary-key",
          foreignKey: "semantic-foreign-key",
          tokenUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          tokenCount: 14,
          tokenLimit: 100,
          accessToken: "access-token-private",
          credits: { balance: "balanced credits" },
          toolResult: {
            balance: "trade-offs are even",
            credits: "acknowledgements",
            rateLimits: { requestsPerMinute: 30 },
            serverName: "public-api-1",
            hostName: "deployment-target",
            environmentId: "semantic-environment",
            host: { serverName: "nested-prod-api" },
            device: { environmentId: "nested-semantic-environment" },
            usage: { rateLimits: { requestsPerMinute: 31 } },
            account: { balance: "balanced workload" },
            semanticAccountMethod: { method: "account/summary", balance: "balanced method workload" },
            semanticMachineMethod: { method: "remoteControl/status/changed", environmentId: "semantic method environment" },
            [join(homedir(), "private-key")]: "home-key-value",
            [join(dirname(homedir()), "[redacted]", "private-key")]: "collision-value",
            ["__proto__"]: "semantic-prototype-key",
          },
          semanticNote: "Keep Mac compatibility",
        },
      });
      active.sink.emit({
        type: "provider.event",
        data: {
          method: "remoteControl/status/changed",
          params: {
            serverName: "Private-Mac.local",
            installationId: "stable-installation-id",
            environmentId: "stable-environment-id",
            displayName: "Vishal's Mac",
            ipAddress: "192.0.2.42",
            macAddress: "00:11:22:33:44:55",
          },
        },
      });
      active.sink.emit({
        type: "provider.event",
        data: {
          method: "account/rateLimits/updated",
          params: {
            email: "private@example.test",
            accountId: "private-account-id",
            organizationId: "private-organization-id",
            displayName: "Private Person",
            credits: "657.5189160000",
            balance: "private-balance",
            rateLimits: { primary: { usedPercent: 42 }, planType: "private-plan" },
          },
        },
      });
      active.sink.emit({
        type: "provider.event",
        data: {
          method: "account/login/completed",
          params: { loginId: "private-login-id", profile: { handle: "private-handle", phoneNumber: "+1-555-0100" } },
        },
      });
      active.sink.emit({
        type: "provider.event",
        data: {
          method: "machine/status/updated",
          params: { ownerEmail: "machine-owner@example.test", hardwareId: "private-hardware-id" },
        },
      });
      const child = active.sink.openStream({ name: "Evidence worker", kind: "worker", providerStreamId: "provider-child" });
      const tool = child.openSpan({ name: "Search", kind: "tool", providerSpanId: "provider-tool" });
      tool.emit({ type: "tool.call.started", data: { query: "evidence", sizeJustification: "private layer reason" } });
      tool.end("completed", { result: "Bearer another-secret" });
      child.close("completed");
      await active.sink.attach({ name: "note.txt", mediaType: "text/plain", content: "OPENAI_API_KEY=sk-secretsecretsecret", sensitivity: "sensitive" });
      await expect(active.sink.attach({ name: "native.json", mediaType: "application/json", content: "{}", sensitivity: "normal", native: true, sanitized: true })).rejects.toThrow("disabled");
      const descriptor = await active.seal("complete");

      expect(descriptor).toMatchObject({ status: "complete", eventCount: expect.any(Number), redactionCount: expect.any(Number) });
      await store.export(3, target, {
        runId: "run-1",
        executionId: "execution-1",
        interactionId: "3",
        harnessConfigurationName: "fixture-trace",
      });
      await expect(readFile(join(directory, "spool", "id-1", "manifest.json"), "utf8")).rejects.toThrow();
      const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
      const events = await readFile(join(target, "events.jsonl"), "utf8");
      const eventStrings: string[] = [];
      const collectStrings = (value: unknown): void => {
        if (typeof value === "string") eventStrings.push(value);
        else if (Array.isArray(value)) value.forEach(collectStrings);
        else if (value && typeof value === "object") Object.values(value).forEach(collectStrings);
      };
      events.trim().split("\n").map((line) => JSON.parse(line)).forEach(collectStrings);
      const attachment = await readFile(join(target, "attachments", "id-5.txt"), "utf8");
      expect(manifest).toMatchObject({
        format: "relayer-harness-trace-v1",
        correlation: { runId: "run-1", executionId: "execution-1", interactionId: "3" },
      });
      expect(events).toContain("stream.started");
      expect(events).toContain("span.completed");
      expect(events).not.toContain("secret-token");
      expect(events).toContain('"credits":{"balance":"balanced credits"}');
      expect(events).toContain('"balance":"trade-offs are even"');
      expect(events).toContain('"credits":"acknowledgements"');
      expect(events).toContain('"serverName":"public-api-1"');
      expect(events).toContain('"hostName":"deployment-target"');
      expect(events).toContain('"environmentId":"semantic-environment"');
      expect(events).toContain('"host":{"serverName":"nested-prod-api"}');
      expect(events).toContain('"device":{"environmentId":"nested-semantic-environment"}');
      expect(events).toContain('"usage":{"rateLimits":{"requestsPerMinute":31}}');
      expect(events).toContain('"account":{"balance":"balanced workload"}');
      expect(events).toContain('"semanticAccountMethod":{"method":"account/summary","balance":"balanced method workload"}');
      expect(events).toContain('"semanticMachineMethod":{"method":"remoteControl/status/changed","environmentId":"semantic method environment"}');
      expect(events).toContain('"rateLimits":{"requestsPerMinute":30}');
      expect(events).toContain("Keep Mac compatibility");
      expect(events).toContain("https://api.example/home/products");
      expect(events).toContain("/home/products semantic");
      expect(events).not.toContain("private-user");
      expect(events).not.toContain("Private-Mac.local");
      expect(events).not.toContain("stable-installation-id");
      expect(events).not.toContain("stable-environment-id");
      expect(events).not.toContain("Vishal's Mac");
      expect(events).not.toContain("192.0.2.42");
      expect(events).not.toContain("00:11:22:33:44:55");
      expect(events).not.toContain("private@example.test");
      expect(events).not.toContain("private-account-id");
      expect(events).not.toContain("private-organization-id");
      expect(events).not.toContain("private-login-id");
      expect(events).not.toContain("private-handle");
      expect(events).not.toContain("+1-555-0100");
      expect(events).not.toContain("machine-owner@example.test");
      expect(events).not.toContain("private-hardware-id");
      expect(events).toContain('"method":"account/login/completed","params":{"loginId":"[redacted]","profile":{"handle":"[redacted]","phoneNumber":"[redacted]"}}');
      expect(events).toContain('"method":"machine/status/updated","params":{"ownerEmail":"[redacted]","hardwareId":"[redacted]"}');
      expect(events).not.toContain(join(homedir(), "private-project"));
      expect(eventStrings.some((value) => value.toLowerCase() === basename(homedir()).toLowerCase())).toBe(false);
      expect(eventStrings.some((value) => value.toLowerCase().includes(`${basename(homedir()).toLowerCase()}@`))).toBe(false);
      expect(eventStrings.some((value) => value.toLowerCase() === hostname().toLowerCase())).toBe(false);
      expect(eventStrings.some((value) => value.toLowerCase().includes(`@${hostname().toLowerCase()}`))).toBe(false);
      expect(events).toContain("Keep the root layer");
      expect(events).not.toContain("private-plan");
      expect(events).not.toContain("private-balance");
      expect(events).toContain("/Users/[redacted]/project");
      expect(events).toContain("D:\\\\Users\\\\[redacted]\\\\project");
      expect(events).toContain("C:/Users/[redacted]/project");
      expect(events).toContain("file:///D:/Users/[redacted]/project");
      expect(events).toContain("/private/var/folders/[redacted]/T/project");
      expect(events).not.toContain("private-token");
      expect(events).not.toContain("ghp_private");
      expect(events).not.toContain("private-aws");
      expect(events).not.toContain("private-npm");
      expect(events).not.toContain("private-client");
      expect(events).not.toContain("camel-token-private");
      expect(events).not.toContain("camel-secret-private");
      expect(events).not.toContain("camel-key-private");
      expect(events).not.toContain("header-key-private");
      expect(events).not.toContain("private-basic");
      expect(events).not.toContain("exported-private");
      expect(events).not.toContain("declared-private");
      expect(events).not.toContain("live-password");
      expect(events).toContain("postgres://[redacted]@db.example/app");
      expect(events).not.toContain("serialized-json-private");
      expect(events).not.toContain("yaml-block-private");
      expect(events).not.toContain("second-private-line");
      expect(events).not.toContain("folded-private");
      expect(events).not.toContain("sequence-private");
      expect(events).not.toContain("quoted-private");
      expect(events).toContain("semantic: retained");
      expect(events).not.toContain("truncated-pem-private");
      expect(events).not.toContain("access-token-private");
      expect(events).toContain('"tokenUsage":{"inputTokens":10,"outputTokens":4,"totalTokens":14}');
      expect(events).toContain('"tokenCount":14');
      expect(events).toContain('"tokenLimit":100');
      expect(events).toContain("semantic-client-key");
      expect(events).toContain("semantic-primary-key");
      expect(events).toContain("semantic-foreign-key");
      expect(events).toContain('"__proto__":"semantic-prototype-key"');
      expect(events).toContain("[redacted-key-collision-2]");
      expect(events).not.toContain(`uid=501(${basename(homedir())})`);
      expect(events).not.toContain(join(homedir(), "private-key"));
      expect(events).toContain("[redacted-user]");
      expect(events).toContain("[redacted-host]");
      expect(events).toContain('"params":{"email":"[redacted]","accountId":"[redacted]","organizationId":"[redacted]","displayName":"[redacted]","credits":"[redacted]","balance":"[redacted]","rateLimits":"[redacted]"}');
      expect(events).not.toContain("private layer reason");
      expect(attachment).not.toContain("secretsecretsecret");
      await expect(store.export(3, join(directory, "second"), {
        runId: "run-1", executionId: "execution-1", interactionId: "3", harnessConfigurationName: "fixture-trace",
      })).rejects.toThrow("No candidate trace exists");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts macOS temporary paths idempotently", () => {
    const once = redactTraceData("/private/var/folders/xy/private-token/T/project");
    expect(once).toBe("/private/var/folders/[redacted]/T/project");
    expect(redactTraceData(once)).toBe(once);
    const symlinkForm = redactTraceData("/var/folders/xy/private-token/T/project");
    expect(symlinkForm).toBe("/var/folders/[redacted]/T/project");
    expect(redactTraceData(symlinkForm)).toBe(symlinkForm);
  });

  it("redacts complete and truncated armored OpenPGP private-key blocks idempotently", () => {
    const complete = [
      "before",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "Version: OpenPGP.js v6",
      "",
      "private-armored-material",
      "=checksum",
      "-----END PGP PRIVATE KEY BLOCK-----",
      "after",
    ].join("\n");
    const redactedComplete = redactTraceData(complete);
    expect(redactedComplete).toBe("before\n[redacted-private-key-block]\nafter");
    expect(redactedComplete).not.toContain("private-armored-material");
    expect(redactTraceData(redactedComplete)).toBe(redactedComplete);

    const truncated = [
      "prefix",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "truncated-private-armored-material",
    ].join("\n");
    const redactedTruncated = redactTraceData(truncated);
    expect(redactedTruncated).toBe("prefix\n[redacted-private-key-block]");
    expect(redactedTruncated).not.toContain("truncated-private-armored-material");
    expect(redactTraceData(redactedTruncated)).toBe(redactedTruncated);
  });

  it("does not redact public or malformed OpenPGP armor", () => {
    const values = [
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\npublic-material\n-----END PGP PUBLIC KEY BLOCK-----",
      "-----BEGIN PGP PRIVATE KEY BLOB-----\nmalformed-private-label\n-----END PGP PRIVATE KEY BLOB-----",
      "-----BEGIN PGP PRIVATE KEY BLOCK ----\nmalformed-dashes",
    ];
    for (const value of values) expect(redactTraceData(value)).toBe(value);
  });

  it("does not let a mismatched private-key footer terminate redaction", () => {
    const injectedFooter = [
      "before",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "private-material-before-injected-footer",
      "-----END RSA PRIVATE KEY-----",
      "private-material-after-injected-footer",
      "-----END PGP PRIVATE KEY BLOCK-----",
      "after",
    ].join("\n");
    const redactedInjectedFooter = redactTraceData(injectedFooter);
    expect(redactedInjectedFooter).toBe("before\n[redacted-private-key-block]\nafter");
    expect(redactedInjectedFooter).not.toContain("private-material-before-injected-footer");
    expect(redactedInjectedFooter).not.toContain("private-material-after-injected-footer");
    expect(redactTraceData(redactedInjectedFooter)).toBe(redactedInjectedFooter);

    const mismatchedFooterToEof = [
      "prefix",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "private-material-before-mismatched-footer",
      "-----END RSA PRIVATE KEY-----",
      "private-material-after-mismatched-footer",
    ].join("\n");
    const redactedToEof = redactTraceData(mismatchedFooterToEof);
    expect(redactedToEof).toBe("prefix\n[redacted-private-key-block]");
    expect(redactedToEof).not.toContain("private-material-before-mismatched-footer");
    expect(redactedToEof).not.toContain("private-material-after-mismatched-footer");
    expect(redactTraceData(redactedToEof)).toBe(redactedToEof);
  });

  it("fails closed when nested private-key armor crosses footer order", () => {
    const crossed = [
      "before",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "outer-private-material",
      "-----BEGIN RSA PRIVATE KEY-----",
      "inner-private-material",
      "-----END PGP PRIVATE KEY BLOCK-----",
      "rsa-private-material-after-outer-footer",
      "-----END RSA PRIVATE KEY-----",
      "untrusted-suffix-after-crossed-armor",
    ].join("\n");
    const redacted = redactTraceData(crossed);
    expect(redacted).toBe("before\n[redacted-private-key-block]");
    expect(redacted).not.toContain("outer-private-material");
    expect(redacted).not.toContain("inner-private-material");
    expect(redacted).not.toContain("rsa-private-material-after-outer-footer");
    expect(redacted).not.toContain("untrusted-suffix-after-crossed-armor");
    expect(redactTraceData(redacted)).toBe(redacted);
  });

  it("handles properly nested private-key armor in stack order", () => {
    const nested = [
      "before",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "outer-private-material-before-inner",
      "-----BEGIN RSA PRIVATE KEY-----",
      "inner-private-material",
      "-----END RSA PRIVATE KEY-----",
      "outer-private-material-after-inner",
      "-----END PGP PRIVATE KEY BLOCK-----",
      "after",
    ].join("\n");
    const redacted = redactTraceData(nested);
    expect(redacted).toBe("before\n[redacted-private-key-block]\nafter");
    expect(redacted).not.toContain("outer-private-material-before-inner");
    expect(redacted).not.toContain("inner-private-material");
    expect(redacted).not.toContain("outer-private-material-after-inner");
    expect(redactTraceData(redacted)).toBe(redacted);
  });

  it("fails closed when same-label nested private-key armor remains open", () => {
    const truncatedNested = [
      "before",
      "-----BEGIN RSA PRIVATE KEY-----",
      "outer-private-material",
      "-----BEGIN RSA PRIVATE KEY-----",
      "inner-private-material",
      "-----END RSA PRIVATE KEY-----",
      "outer-private-material-after-inner-footer",
    ].join("\n");
    const redacted = redactTraceData(truncatedNested);
    expect(redacted).toBe("before\n[redacted-private-key-block]");
    expect(redacted).not.toContain("outer-private-material");
    expect(redacted).not.toContain("inner-private-material");
    expect(redacted).not.toContain("outer-private-material-after-inner-footer");
    expect(redactTraceData(redacted)).toBe(redacted);
  });

  it("preserves exact-footer support for standard private-key armor labels", () => {
    for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"]) {
      const source = `before\n-----BEGIN ${label}-----\nprivate-${label}\n-----END ${label}-----\nafter`;
      const redacted = redactTraceData(source);
      expect(redacted).toBe("before\n[redacted-private-key-block]\nafter");
      expect(redacted).not.toContain(`private-${label}`);
      expect(redactTraceData(redacted)).toBe(redacted);
    }
  });

  it("redacts bare GitHub personal access token formats idempotently", () => {
    const legacy = ["ghp", "gho", "ghu", "ghs", "ghr"].map((prefix, index) => `${prefix}_${String(index + 1).repeat(36)}`);
    const fineGrained = `github_pat_${"B".repeat(22)}_${"C".repeat(59)}`;
    const once = redactTraceData([...legacy, fineGrained].join(" "));
    expect(once).toBe(Array(legacy.length + 1).fill("[redacted-github-token]").join(" "));
    expect(redactTraceData(once)).toBe(once);
    for (const token of legacy) expect(once).not.toContain(token);
    expect(once).not.toContain(fineGrained);
  });

  it("does not redact GitHub-like prose or malformed token lengths", () => {
    const values = [
      "gho_documentation",
      `prefixghp_${"A".repeat(36)}`,
      `ghr_${"A".repeat(36)}_documentation`,
      `ghu_${"B".repeat(35)}`,
      `ghs_${"C".repeat(37)}`,
      `github_pat_${"D".repeat(81)}`,
      `github_pat_${"E".repeat(83)}`,
    ];
    const prose = values.join(" ");
    expect(redactTraceData(prose)).toBe(prose);
  });

  it("redacts bare Slack credentials idempotently", () => {
    const tokens = [
      `xoxb-${"1".repeat(12)}-${"2".repeat(13)}-${"A".repeat(24)}`,
      `xoxp-${"B".repeat(48)}`,
      `xoxe.xoxp-${"C".repeat(64)}`,
      `xapp-${"D".repeat(48)}`,
      `xwfp-${"E".repeat(48)}`,
    ];
    const once = redactTraceData(tokens.join(" "));
    expect(once).toBe(Array(tokens.length).fill("[redacted-slack-token]").join(" "));
    expect(redactTraceData(once)).toBe(once);
    for (const token of tokens) expect(once).not.toContain(token);
  });

  it("does not redact Slack-like prose or malformed token lengths", () => {
    const values = [
      "xoxb documentation",
      `prefixxoxp-${"A".repeat(24)}`,
      `xoxa-${"B".repeat(9)}`,
      `xapp-${"D".repeat(9)}`,
    ];
    const prose = values.join(" ");
    expect(redactTraceData(prose)).toBe(prose);
  });

  it("redacts bare GitLab credentials idempotently", () => {
    const tokens = [
      "glpat-0123456789abcdefghij",
      `gloas-${"A".repeat(32)}`,
      `glsoat-${"B".repeat(20)}`,
      `glagent-${"C".repeat(24)}`,
      `gldt-${"D".repeat(20)}`,
      `glrtr-${"E".repeat(20)}`,
      `glft-${"F".repeat(20)}`,
      `glwt-${"G".repeat(20)}`,
    ];
    const once = redactTraceData(tokens.join(" "));
    expect(once).toBe(Array(tokens.length).fill("[redacted-gitlab-token]").join(" "));
    expect(redactTraceData(once)).toBe(once);
    for (const token of tokens) expect(once).not.toContain(token);
  });

  it("does not redact GitLab-like prose or malformed token lengths", () => {
    const values = [
      "glpat-documentation",
      `prefixglpat-${"A".repeat(20)}`,
      `glpat-${"B".repeat(19)}`,
      `glunknown-${"D".repeat(24)}`,
    ];
    const prose = values.join(" ");
    expect(redactTraceData(prose)).toBe(prose);
  });

  it("redacts bare npm granular access tokens idempotently", () => {
    const token = `npm_${"A1b2C3".repeat(6)}`;
    const once = redactTraceData(`observed (${token})`);
    expect(once).toBe("observed ([redacted-npm-token])");
    expect(once).not.toContain(token);
    expect(redactTraceData(once)).toBe(once);
  });

  it("does not redact npm-like prose or malformed token lengths", () => {
    const values = [
      "npm_documentation",
      `prefixnpm_${"A".repeat(36)}`,
      `npm_${"B".repeat(35)}`,
      `npm_${"C".repeat(37)}`,
      `npm_${"D".repeat(36)}_suffix`,
    ];
    const prose = values.join(" ");
    expect(redactTraceData(prose)).toBe(prose);
  });

  it("redacts bare live and test Stripe secret credentials idempotently", () => {
    const keys = [
      `sk_live_${"A1b2C3".repeat(4)}`,
      `rk_live_${"D4e5F6".repeat(8)}`,
      `sk_test_${"J0k1L2".repeat(4)}`,
      `rk_test_${"G7h8I9".repeat(4)}`,
    ];
    const once = redactTraceData(keys.join(" "));
    expect(once).toBe(Array(keys.length).fill("[redacted-stripe-key]").join(" "));
    expect(redactTraceData(once)).toBe(once);
    for (const key of keys) expect(once).not.toContain(key);
  });

  it("does not redact public, prefixed, or malformed Stripe-key shapes", () => {
    const values = [
      `pk_live_${"A".repeat(24)}`,
      `pk_test_${"B".repeat(24)}`,
      `prefixsk_live_${"C".repeat(24)}`,
      `sk_live_${"D".repeat(23)}`,
      `rk_test_${"F".repeat(24)}_suffix`,
      `sk_testmode_${"G".repeat(24)}`,
      `rk_sandbox_${"H".repeat(24)}`,
    ];
    const prose = values.join(" ");
    expect(redactTraceData(prose)).toBe(prose);
  });

  it("redacts standalone Hugging Face access tokens in prose and structured values idempotently", () => {
    const first = `hf_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7".slice(0, 34)}`;
    const second = `hf_${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3".slice(0, 34)}`;
    expect(first).toHaveLength(37);
    expect(second).toHaveLength(37);

    const prose = redactTraceData(`request (${first})`);
    expect(prose).toBe("request ([redacted-hugging-face-token])");
    expect(redactTraceData(prose)).toBe(prose);

    expect(redactTraceData({ semanticValue: second, retained: "hf_ documentation" })).toEqual({
      semanticValue: "[redacted-hugging-face-token]",
      retained: "hf_ documentation",
    });
    const structured = redactTraceData(`semanticValue: ${second}\nretained: public`);
    expect(structured).toBe("semanticValue: [redacted-hugging-face-token]\nretained: public");
    expect(redactTraceData(structured)).toBe(structured);
  });

  it("does not redact Hugging Face near misses, embedded identifiers, or case variants", () => {
    const validBody = "A".repeat(34);
    const values = [
      "hf_ documentation",
      `hf_${"B".repeat(33)}`,
      `hf_${"C".repeat(35)}`,
      `prefixhf_${validBody}`,
      `hf_${validBody}_suffix`,
      `HF_${validBody}`,
      `Hf_${validBody}`,
      `hf_${"D".repeat(17)}-${"E".repeat(16)}`,
    ];
    const prose = values.join(" ");
    expect(redactTraceData(prose)).toBe(prose);
  });

  it("redacts standalone Google API keys in prose and structured values idempotently", () => {
    const first = `AIza${"A1_b-2".repeat(5)}A1_b-`;
    const second = `AIza${"Z9-y_8".repeat(5)}Z9-y_`;
    expect(first).toHaveLength(39);
    expect(second).toHaveLength(39);

    const prose = redactTraceData(`request (${first})`);
    expect(prose).toBe("request ([redacted-google-api-key])");
    expect(redactTraceData(prose)).toBe(prose);

    expect(redactTraceData({ semanticValue: second, retained: "AIza documentation" })).toEqual({
      semanticValue: "[redacted-google-api-key]",
      retained: "AIza documentation",
    });
    const structured = redactTraceData(`semanticValue: ${second}\nretained: public`);
    expect(structured).toBe("semanticValue: [redacted-google-api-key]\nretained: public");
  });

  it("does not redact Google-key near misses or embedded identifier fragments", () => {
    const validBody = "A".repeat(35);
    const values = [
      "AIza documentation",
      `AIza${"B".repeat(34)}`,
      `AIza${"C".repeat(36)}`,
      `prefixAIza${validBody}`,
      `AIza${validBody}_suffix`,
      `aiza${validBody}`,
      `AIza${"D".repeat(17)}.${"E".repeat(17)}`,
    ];
    const prose = values.join(" ");
    expect(redactTraceData(prose)).toBe(prose);
  });

  it("redacts passphrase-named object, structured, and shell fields", () => {
    const object = redactTraceData({
      passphrase: "object-passphrase-private",
      gpgPassphrase: "camel-passphrase-private",
      passphraseHint: "hint-private",
      semantic: "preserved-object-sibling",
    });
    expect(object).toEqual({
      passphrase: "[redacted]",
      gpgPassphrase: "[redacted]",
      passphraseHint: "[redacted]",
      semantic: "preserved-object-sibling",
    });

    const structured = redactTraceData([
      'passphrase: "yaml-passphrase-private"',
      "gpg_passphrase: yaml-gpg-passphrase-private",
      "semantic: preserved-yaml-sibling",
    ].join("\n"));
    expect(structured).not.toContain("yaml-passphrase-private");
    expect(structured).not.toContain("yaml-gpg-passphrase-private");
    expect(structured).toContain("semantic: preserved-yaml-sibling");
    expect(redactTraceData(structured)).toBe(structured);

    const shell = redactTraceData([
      "GPG_PASSPHRASE=env-passphrase-private command --safe",
      "export SSH_PASSPHRASE='export-passphrase-private'",
      "semantic=preserved-shell-value",
    ].join("\n"));
    expect(shell).not.toContain("env-passphrase-private");
    expect(shell).not.toContain("export-passphrase-private");
    expect(shell).toContain("semantic=preserved-shell-value");
    expect(redactTraceData(shell)).toBe(shell);
  });

  it("removes abandoned spool entries before sealing the first trace after startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-abandoned-spool-"));
    const spool = join(directory, "spool");
    try {
      await mkdir(spool, { mode: 0o700 });
      await mkdir(join(spool, "abandoned-trace", "attachments"), { recursive: true });
      await writeFile(join(spool, "abandoned-trace", "events.jsonl"), "partial");
      await writeFile(join(spool, "abandoned-temporary-file"), "partial");
      const store = new HarnessTraceStore({ directory: spool, policy: policy(), createId: (() => {
        let id = 0;
        return () => `fresh-${++id}`;
      })() });
      const active = store.start({
        threadId: 1,
        interactionNodeId: 2,
        productInteractionId: 3,
        implementation: "fixture.trace",
        configurationName: "fixture-trace",
        support: fullSupport,
      });

      await active.seal("complete");

      await expect(readFile(join(spool, "abandoned-trace", "events.jsonl"), "utf8")).rejects.toThrow();
      await expect(readFile(join(spool, "abandoned-temporary-file"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(join(spool, "fresh-1", "manifest.json"), "utf8"))).toMatchObject({ traceId: "fresh-1" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a symlink spool root without deleting its target contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-spool-root-link-"));
    const victim = join(directory, "victim");
    const proof = join(victim, "must-survive.txt");
    const spool = join(directory, "spool");
    try {
      await mkdir(victim, { mode: 0o700 });
      await writeFile(proof, "preserved\n");
      await symlink(victim, spool, "dir");
      const store = new HarnessTraceStore({ directory: spool, policy: policy() });

      await expect(sealFixtureTrace(store)).rejects.toThrow("must be a real directory");
      await expect(readFile(proof, "utf8")).resolves.toBe("preserved\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked spool ancestor without deleting the resolved victim spool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-spool-ancestor-link-"));
    const victimParent = join(directory, "victim-parent");
    const victimSpool = join(victimParent, "spool");
    const proof = join(victimSpool, "must-survive.txt");
    const alias = join(directory, "alias");
    try {
      await mkdir(victimSpool, { recursive: true, mode: 0o700 });
      await chmod(victimSpool, 0o700);
      await writeFile(proof, "preserved through ancestor\n");
      await symlink(victimParent, alias, "dir");
      const store = new HarnessTraceStore({ directory: join(alias, "spool"), policy: policy() });

      await expect(sealFixtureTrace(store)).rejects.toThrow("ancestor must not be a symbolic link");
      await expect(readFile(proof, "utf8")).resolves.toBe("preserved through ancestor\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a real spool ancestor is swapped for a victim symlink during startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-spool-ancestor-race-"));
    const parent = join(directory, "owned-parent");
    const detachedParent = join(directory, "detached-parent");
    const spool = join(parent, "spool");
    const victimParent = join(directory, "victim-parent");
    const victimSpool = join(victimParent, "spool");
    const proof = join(victimSpool, "must-survive.txt");
    try {
      await mkdir(spool, { recursive: true, mode: 0o700 });
      await chmod(spool, 0o700);
      await writeFile(join(spool, "abandoned.txt"), "old trace\n");
      await mkdir(victimSpool, { recursive: true, mode: 0o700 });
      await chmod(victimSpool, 0o700);
      await writeFile(proof, "race victim preserved\n");

      const store = new HarnessTraceStore({ directory: spool, policy: policy() });
      // cleanupAbandonedSpool suspends on its first lstat before it can traverse
      // the user-owned ancestor, making this a deterministic swap at that edge.
      renameSync(parent, detachedParent);
      symlinkSync(victimParent, parent, "dir");

      await expect(sealFixtureTrace(store)).rejects.toThrow("ancestor must not be a symbolic link");
      await expect(readFile(proof, "utf8")).resolves.toBe("race victim preserved\n");
      await expect(readFile(join(detachedParent, "spool", "abandoned.txt"), "utf8")).resolves.toBe("old trace\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-directory and permissive spool roots", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-invalid-spool-"));
    const fileRoot = join(directory, "file-spool");
    const permissiveRoot = join(directory, "permissive-spool");
    try {
      await writeFile(fileRoot, "not a directory\n");
      await mkdir(permissiveRoot, { mode: 0o700 });
      await chmod(permissiveRoot, 0o755);

      await expect(sealFixtureTrace(new HarnessTraceStore({ directory: fileRoot, policy: policy() })))
        .rejects.toThrow("must be a real directory");
      await expect(sealFixtureTrace(new HarnessTraceStore({ directory: permissiveRoot, policy: policy() })))
        .rejects.toThrow("permissions must be 0700");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a spool root not owned by the effective user", async () => {
    if (process.platform === "win32" || process.getuid === undefined) return;
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-spool-owner-"));
    const spool = join(directory, "spool");
    const actualUid = process.getuid();
    try {
      await mkdir(spool, { mode: 0o700 });
      const getuid = vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);
      try {
        await expect(sealFixtureTrace(new HarnessTraceStore({ directory: spool, policy: policy() })))
          .rejects.toThrow("must be owned by the current user");
      } finally {
        getuid.mockRestore();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes an abandoned entry symlink without following its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-spool-entry-link-"));
    const spool = join(directory, "spool");
    const victim = join(directory, "outside.txt");
    const entry = join(spool, "abandoned-link");
    try {
      await mkdir(spool, { mode: 0o700 });
      await writeFile(victim, "outside survives\n");
      await symlink(victim, entry, "file");
      const store = new HarnessTraceStore({ directory: spool, policy: policy(), createId: () => "fresh" });

      await sealFixtureTrace(store);

      await expect(readFile(victim, "utf8")).resolves.toBe("outside survives\n");
      await expect(readFile(entry, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(join(spool, "fresh", "manifest.json"), "utf8"))).toMatchObject({ traceId: "fresh" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts complete structured credential scalars without removing YAML siblings", () => {
    const explicitBlockMappings = [
      {
        source: [
          "? clientSecret # explicit key comment",
          "# preserved explicit-key bridge comment",
          ": explicit-block-scalar-private",
          "explicitScalarSibling: preserved-explicit-block-scalar-sibling",
        ].join("\n"),
        parsed: { clientSecret: "explicit-block-scalar-private", explicitScalarSibling: "preserved-explicit-block-scalar-sibling" },
      },
      {
        source: [
          String.raw`? "client\u0053ecret"`,
          ": unicode-explicit-block-scalar-private",
          "unicodeExplicitScalarSibling: preserved-unicode-explicit-block-scalar-sibling",
        ].join("\n"),
        parsed: { clientSecret: "unicode-explicit-block-scalar-private", unicodeExplicitScalarSibling: "preserved-unicode-explicit-block-scalar-sibling" },
      },
      {
        source: [
          "- ? privateKey",
          "  : |",
          "    explicit-block-value-private",
          "    second-explicit-block-value-private",
          "  name: preserved-explicit-block-value-sibling",
        ].join("\n"),
        parsed: [{ privateKey: "explicit-block-value-private\nsecond-explicit-block-value-private\n", name: "preserved-explicit-block-value-sibling" }],
      },
      {
        source: [
          String.raw`- - ? "client\u0053ecret" # nested explicit key comment`,
          "    # preserved nested explicit-key bridge comment",
          "    : >",
          "      nested-unicode-explicit-block-private",
          "    name: preserved-nested-unicode-explicit-sibling",
        ].join("\n"),
        parsed: [[{ clientSecret: "nested-unicode-explicit-block-private\n", name: "preserved-nested-unicode-explicit-sibling" }]],
      },
    ];
    for (const { source, parsed } of explicitBlockMappings) expect(parseYaml(source)).toEqual(parsed);
    const redacted = redactTraceData([
      "mixed trace fragments",
      String.raw`{"clientSecret":"prefix\"escaped-json-private"}`,
      String.raw`{"client\u0053ecret":"unicode-key-private"}`,
      String.raw`{"api\u005fkey":"unicode-api-private"}`,
      String.raw`{"client\u0053ecret": unicode-yaml-plain-private, name: preserved-unicode-plain-sibling}`,
      String.raw`{? "client\u0053ecret": unicode-yaml-explicit-private, name: preserved-unicode-explicit-sibling}`,
      "- clientSecret: sequence-plain-private",
      '- "privateKey": sequence-quoted-key-private',
      "- {clientSecret: flow-map-private, name: preserved-flow-sibling}",
      "{? clientSecret: explicit-flow-private, name: preserved-explicit-flow-sibling}",
      "- - clientSecret: nested-sequence-private",
      "- clientSecret: |",
      "    sequence-block-private",
      "  name: preserved-sequence-sibling",
      "- - privateKey: |",
      "      nested-sequence-block-private",
      "    name: preserved-nested-sequence-sibling",
      String.raw`"client\u0053ecret": |`,
      "  unicode-yaml-block-private",
      "unicodeBlockSibling: preserved-unicode-block-sibling",
      ...explicitBlockMappings.map(({ source }) => source),
    ].join("\n"));

    expect(redacted).not.toContain("escaped-json-private");
    expect(redacted).not.toContain("unicode-key-private");
    expect(redacted).not.toContain("unicode-api-private");
    expect(redacted).not.toContain("unicode-yaml-plain-private");
    expect(redacted).not.toContain("unicode-yaml-explicit-private");
    expect(redacted).not.toContain("unicode-yaml-block-private");
    expect(redacted).not.toContain("sequence-plain-private");
    expect(redacted).not.toContain("sequence-quoted-key-private");
    expect(redacted).not.toContain("flow-map-private");
    expect(redacted).not.toContain("explicit-flow-private");
    expect(redacted).not.toContain("nested-sequence-private");
    expect(redacted).not.toContain("sequence-block-private");
    expect(redacted).not.toContain("nested-sequence-block-private");
    expect(redacted).not.toContain("explicit-block-scalar-private");
    expect(redacted).not.toContain("unicode-explicit-block-scalar-private");
    expect(redacted).not.toContain("explicit-block-value-private");
    expect(redacted).not.toContain("second-explicit-block-value-private");
    expect(redacted).not.toContain("nested-unicode-explicit-block-private");
    expect(redacted).toContain("name: preserved-flow-sibling");
    expect(redacted).toContain("name: preserved-explicit-flow-sibling");
    expect(redacted).toContain("name: preserved-unicode-plain-sibling");
    expect(redacted).toContain("name: preserved-unicode-explicit-sibling");
    expect(redacted).toContain("name: preserved-sequence-sibling");
    expect(redacted).toContain("name: preserved-nested-sequence-sibling");
    expect(redacted).toContain("unicodeBlockSibling: preserved-unicode-block-sibling");
    expect(redacted).toContain("explicitScalarSibling: preserved-explicit-block-scalar-sibling");
    expect(redacted).toContain("unicodeExplicitScalarSibling: preserved-unicode-explicit-block-scalar-sibling");
    expect(redacted).toContain("name: preserved-explicit-block-value-sibling");
    expect(redacted).toContain("name: preserved-nested-unicode-explicit-sibling");
    expect(redacted).toContain("# preserved explicit-key bridge comment");
    expect(redacted).toContain("# preserved nested explicit-key bridge comment");
    expect(redactTraceData(redacted)).toBe(redacted);
  });

  it("redacts parser-valid YAML structures using YAML key semantics", () => {
    const cases = [
      {
        source: String.raw`{"client\x53ecret":{"nested":"json-private"},"name":"json-sibling"}`,
        secrets: ["json-private"],
        siblings: ["json-sibling"],
      },
      {
        source: String.raw`"client\x53ecret": yaml-x-private
sibling: x-sibling`,
        secrets: ["yaml-x-private"],
        siblings: ["x-sibling"],
      },
      {
        source: String.raw`{ "private\U0000004Bey": yaml-U-flow-private, name: U-flow-sibling }`,
        secrets: ["yaml-U-flow-private"],
        siblings: ["U-flow-sibling"],
      },
      {
        source: String.raw`!!str "client\x53ecret": tagged-private
sibling: tagged-sibling`,
        secrets: ["tagged-private"],
        siblings: ["tagged-sibling"],
      },
      {
        source: "&credentialKey clientSecret: anchored-key-private\nsibling: anchored-sibling",
        secrets: ["anchored-key-private"],
        siblings: ["anchored-sibling"],
      },
      {
        source: "semanticLabel: &credentialKey clientSecret\n? *credentialKey\n: alias-key-private\nsibling: alias-sibling",
        secrets: ["alias-key-private"],
        siblings: ["semanticLabel", "alias-sibling"],
      },
      {
        source: "? clientSecret # explicit key comment\n  : explicit-indent-private\nsibling: explicit-indent-sibling",
        secrets: ["explicit-indent-private"],
        siblings: ["# explicit key comment", "explicit-indent-sibling"],
      },
      {
        source: String.raw`- - ? !!str "client\x53ecret"
    : |
      nested-block-private
    name: nested-sibling`,
        secrets: ["nested-block-private"],
        siblings: ["nested-sibling"],
      },
      {
        source: "clientSecret:\n  nested: container-private\nsibling: container-sibling",
        secrets: ["container-private"],
        siblings: ["container-sibling"],
      },
      {
        source: String.raw`scalar document remains
---
"client\x53ecret": mixed-document-private
sibling: mixed-document-sibling`,
        secrets: ["mixed-document-private"],
        siblings: ["scalar document remains", "mixed-document-sibling"],
        multipleDocuments: true,
      },
    ];

    for (const { source, secrets, siblings, multipleDocuments } of cases) {
      if (multipleDocuments) {
        expect(parseAllDocuments(source).every((document) => document.errors.length === 0)).toBe(true);
      } else {
        expect(() => parseYaml(source)).not.toThrow();
      }
      const redacted = redactTraceData(source);
      expect(typeof redacted).toBe("string");
      if (typeof redacted !== "string") throw new Error("Structured trace redaction must return text for text input");
      for (const secret of secrets) expect(redacted).not.toContain(secret);
      for (const sibling of siblings) expect(redacted).toContain(sibling);
      if (multipleDocuments) {
        expect(parseAllDocuments(redacted).every((document) => document.errors.length === 0)).toBe(true);
      } else {
        expect(() => parseYaml(redacted)).not.toThrow();
      }
      expect(redactTraceData(redacted)).toBe(redacted);
    }
  });

  it("fails closed when structured redaction budgets are exceeded", () => {
    const aliasHeavy = Array.from({ length: 65 }, (_, index) => [
      `- semantic: &credentialKey${index} clientSecret`,
      `  ? *credentialKey${index}`,
      `  : private-${index}`,
    ].join("\n")).join("\n");
    expect(() => parseYaml(aliasHeavy)).not.toThrow();
    expect(redactTraceData(aliasHeavy)).toBe("[structured content omitted]");
    const oversized = redactTraceData(`semantic: ${"x".repeat(128_001)}`);
    expect(oversized).toContain("semantic:");
    expect(oversized).toContain("[content truncated]");
  });

  it("fails closed for ambiguous credential-bearing YAML structures", () => {
    const ambiguous = [
      "payload: &sensitiveValue alias-value-private\nclientSecret: *sensitiveValue\nsibling: alias-value-sibling",
      "# top comment\npayload: &commentedValue top-comment-alias-private\nclientSecret: *commentedValue\nsibling: top-comment-alias-sibling",
      "payload: &nestedMapValue nested-map-alias-private\nclientSecret:\n  nested: *nestedMapValue\nsibling: nested-map-alias-sibling",
      "%YAML 1.2\n---\n# top nested comment\npayload: &commentedNestedValue top-comment-nested-alias-private\nclientSecret:\n  nested: *commentedNestedValue\nsibling: top-comment-nested-alias-sibling",
      "payload: &nestedSequenceValue nested-sequence-alias-private\nclientSecret:\n  - public\n  - *nestedSequenceValue\nsibling: nested-sequence-alias-sibling",
      "? &complexKey\n  clientSecret: complex-key-private\n: public-value\nsibling: complex-key-sibling",
      "anchorHolder: &complexKey {clientSecret: aliased-complex-key-private}\n? *complexKey\n: public-value\nsibling: aliased-complex-key-sibling",
      "clientSecret: duplicate-first-private\nclientSecret: duplicate-second-private\nsibling: duplicate-sibling",
      String.raw`[
"client\x53ecret": malformed-x-private`,
    ];
    for (const source of ambiguous) {
      const redacted = redactTraceData(source);
      expect(redacted).toBe("[structured content omitted]");
      expect(redactTraceData(redacted)).toBe(redacted);
    }
  });

  it("uses bounded YAML key decoding for oversized structured input", () => {
    for (const key of [String.raw`"client\x53ecret"`, String.raw`"private\U0000004Bey"`]) {
      const credentialBearing = `${key}: ${"x".repeat(128_001)}`;
      expect(redactTraceData(credentialBearing)).toBe("[structured content omitted]");
    }
    const benign = redactTraceData(`semantic: ${"x".repeat(128_001)}`);
    expect(benign).toContain("semantic:");
    expect(benign).toContain("[content truncated]");
    const lateCredential = `payload: &lateValue late-anchored-private\nsemantic: ${"x".repeat(128_001)}\nclientSecret: *lateValue`;
    expect(redactTraceData(lateCredential)).toBe("[structured content omitted]");
    const oversizedKey = `"${"a".repeat(1_025)}clientSecret": ${"x".repeat(128_001)}`;
    expect(redactTraceData(oversizedKey)).toBe("[structured content omitted]");
    const verbatimTagged = `${String.raw`!<tag:yaml.org,2002:str> "client\x53ecret"`}: ${"x".repeat(128_001)}`;
    expect(redactTraceData(verbatimTagged)).toBe("[structured content omitted]");
    const explicitVerbatimTagged = `${String.raw`? !<tag:yaml.org,2002:str> "client\x53ecret"`}\n: ${"x".repeat(128_001)}`;
    expect(redactTraceData(explicitVerbatimTagged)).toBe("[structured content omitted]");
  });

  it("uses YAML scalar semantics in malformed mixed-fragment fallback", () => {
    for (const source of [
      String.raw`not a YAML collection
"client\x53ecret": malformed-x-private`,
      String.raw`not a YAML collection
"private\U0000004Bey": malformed-U-private`,
    ]) {
      const redacted = redactTraceData(source);
      expect(typeof redacted).toBe("string");
      if (typeof redacted !== "string") throw new Error("Text fallback must return text");
      expect(redacted).toContain("not a YAML collection");
      expect(redacted).not.toContain("malformed-x-private");
      expect(redacted).not.toContain("malformed-U-private");
      expect(redactTraceData(redacted)).toBe(redacted);
    }
    const ambiguousSingleQuoted = String.raw`not a YAML collection
'client''Secret': single-quoted-private`;
    expect(redactTraceData(ambiguousSingleQuoted)).toBe("[structured content omitted]");
    expect(redactTraceData("[structured content omitted]")).toBe("[structured content omitted]");
  });

  it("redacts escaped inline assignments and prefixed HTTP transcript headers", () => {
    const source = [
      String.raw`run env DB_PASSWORD="prefix\"suffix-secret" tool --safe`,
      String.raw`run env DB_PASSWORD=$'prefix\nsuffix-ansi-secret' tool --ansi-safe`,
      String.raw`run env DB_PASSWORD=prefix\ suffix-unquoted-secret tool --unquoted-safe`,
      "run env DB_PASSWORD=prefix\u00a0suffix-nbsp-secret tool --nbsp-safe",
      "run env DB_PASSWORD=prefix\u2003suffix-em-space-secret tool --em-space-safe",
      "run env DB_PASSWORD=prefix\vsuffix-vt-secret tool --vt-safe",
      "run env DB_PASSWORD=prefix\fsuffix-ff-secret tool --ff-safe",
      String.raw`run env DB_PASSWORD=plain"suffix-double-secret"'suffix-single-secret'$'suffix-concatenated-secret' tool --concatenated-safe`,
      "> Authorization: Basic basic-private",
      "< Set-Cookie: session=cookie-private; HttpOnly; Secure",
      "> Authorization: Basic folded-basic-private\n>  suffix-folded-auth-private\n> Content-Type: folded-auth-sibling",
      "< Set-Cookie: folded=cookie-private\n<  suffix-folded-cookie-private\n< Content-Type: folded-cookie-sibling",
      "  Proxy-Authorization : Digest proxy-private",
      "Cookie: first=cookie-one-private; second=cookie-two-private",
      "Content-Type: semantic-header-sibling",
      "body Authorization: Basic semantic-body-sibling",
      "final sibling remains",
    ].join("\n");
    const redacted = redactTraceData(source);
    expect(typeof redacted).toBe("string");
    if (typeof redacted !== "string") throw new Error("Text redaction must return text");
    expect(redacted).toContain("run env credential=[redacted] tool --safe");
    expect(redacted).toContain("run env credential=[redacted] tool --ansi-safe");
    expect(redacted).toContain("run env credential=[redacted] tool --unquoted-safe");
    expect(redacted).toContain("run env credential=[redacted] tool --nbsp-safe");
    expect(redacted).toContain("run env credential=[redacted] tool --em-space-safe");
    expect(redacted).toContain("run env credential=[redacted] tool --vt-safe");
    expect(redacted).toContain("run env credential=[redacted] tool --ff-safe");
    expect(redacted).toContain("run env credential=[redacted] tool --concatenated-safe");
    expect(redacted).toContain("> Authorization: [redacted]");
    expect(redacted).toContain("< Set-Cookie: [redacted]");
    expect(redacted).toContain("  Proxy-Authorization : [redacted]");
    expect(redacted).toContain("Cookie: [redacted]");
    expect(redacted).toContain("> Authorization: [redacted]\n> Content-Type: folded-auth-sibling");
    expect(redacted).toContain("< Set-Cookie: [redacted]\n< Content-Type: folded-cookie-sibling");
    expect(redacted).toContain("Content-Type: semantic-header-sibling");
    expect(redacted).toContain("body Authorization: Basic semantic-body-sibling");
    expect(redacted).toContain("final sibling remains");
    for (const secret of [
      "suffix-secret",
      "suffix-ansi-secret",
      "suffix-unquoted-secret",
      "suffix-nbsp-secret",
      "suffix-em-space-secret",
      "suffix-vt-secret",
      "suffix-ff-secret",
      "suffix-double-secret",
      "suffix-single-secret",
      "suffix-concatenated-secret",
      "basic-private",
      "cookie-private",
      "proxy-private",
      "cookie-one-private",
      "cookie-two-private",
      "suffix-folded-auth-private",
      "suffix-folded-cookie-private",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redactTraceData(redacted)).toBe(redacted);
  });

  it("fails closed for complex, malformed, and over-budget shell assignment words", () => {
    const complex = [
      String.raw`run env DB_PASSWORD=$(case value in value) printf '%s' suffix-case-secret;; esac) tool --case-sibling`,
      String.raw`run env DB_PASSWORD=$(cat <<'EOF'
suffix-heredoc-secret
EOF
) tool --heredoc-sibling`,
      String.raw`run env DB_PASSWORD=$(printf '%s' suffix-substitution-secret) tool --substitution-sibling`,
      String.raw`run env DB_PASSWORD="prefix$(case value in value) printf "%s" suffix-double-nested-secret;; esac)suffix" tool --double-nested-sibling`,
      "run env DB_PASSWORD=\"prefix`printf '%s' suffix-double-backtick-secret`suffix\" tool --double-backtick-sibling",
      "run env DB_PASSWORD=`printf '%s' suffix-backtick-secret` tool --backtick-sibling",
      String.raw`run env DB_PASSWORD=<(printf '%s' suffix-process-secret) tool --process-sibling`,
      String.raw`run env DB_PASSWORD=(public suffix-array-secret) tool --array-sibling`,
      String.raw`run env DB_PASSWORD="unterminated-malformed-secret
later-malformed-secret`,
    ];
    for (const source of complex) {
      const redacted = redactTraceData(source);
      expect(redacted).toBe("run env credential=[redacted]");
      expect(redactTraceData(redacted)).toBe(redacted);
    }

    const boundary = `run env DB_PASSWORD=${"x".repeat(16_384)} tool --boundary-sibling`;
    const boundaryRedacted = redactTraceData(boundary);
    expect(boundaryRedacted).toBe("run env credential=[redacted] tool --boundary-sibling");
    expect(redactTraceData(boundaryRedacted)).toBe(boundaryRedacted);

    const overBudget = `run env DB_PASSWORD=${"x".repeat(16_385)} suffix-over-budget-secret`;
    const overBudgetRedacted = redactTraceData(overBudget);
    expect(overBudgetRedacted).toBe("run env credential=[redacted]");
    expect(overBudgetRedacted).not.toContain("suffix-over-budget-secret");
    expect(redactTraceData(overBudgetRedacted)).toBe(overBudgetRedacted);
  });

  it("redacts complete multiline line-start shell assignments before line boundaries", () => {
    const cases = [
      {
        source: `DB_PASSWORD="prefix
suffix-double-multiline-secret" tool --double-sibling`,
        expected: "DB_PASSWORD=[redacted] tool --double-sibling",
      },
      {
        source: `DB_PASSWORD='prefix
suffix-single-multiline-secret' tool --single-sibling`,
        expected: "DB_PASSWORD=[redacted] tool --single-sibling",
      },
      {
        source: `DB_PASSWORD=$'prefix
suffix-ansi-multiline-secret' tool --ansi-sibling`,
        expected: "DB_PASSWORD=[redacted] tool --ansi-sibling",
      },
      {
        source: `export DB_PASSWORD="prefix
suffix-export-multiline-secret" tool --export-sibling`,
        expected: "export DB_PASSWORD=[redacted] tool --export-sibling",
      },
    ];
    for (const { source, expected } of cases) {
      const redacted = redactTraceData(source);
      expect(redacted).toBe(expected);
      expect(redacted).not.toContain("multiline-secret");
      expect(redactTraceData(redacted)).toBe(redacted);
    }
  });

  it("redacts append and indexed assignments without crossing an empty assignment line", () => {
    const cases = [
      {
        source: "DB_PASSWORD+=suffix-bash-append-secret tool --append-sibling",
        expected: "DB_PASSWORD+=[redacted] tool --append-sibling",
      },
      {
        source: "DB_PASSWORD[0]=suffix-bash-index-secret tool --bash-index-sibling",
        expected: "DB_PASSWORD[0]=[redacted] tool --bash-index-sibling",
      },
      {
        source: "DB_PASSWORD[1]=suffix-zsh-index-secret tool --zsh-index-sibling",
        expected: "DB_PASSWORD[1]=[redacted] tool --zsh-index-sibling",
      },
      {
        source: "DB_PASSWORD[foo[bar]]=suffix-bash-nested-secret tool --bash-nested-sibling",
        expected: "DB_PASSWORD[foo[bar]]=[redacted] tool --bash-nested-sibling",
      },
      {
        source: "DB_PASSWORD[foo[bar]]=suffix-zsh-nested-secret tool --zsh-nested-sibling",
        expected: "DB_PASSWORD[foo[bar]]=[redacted] tool --zsh-nested-sibling",
      },
      {
        source: "export DB_PASSWORD[foo[bar]]=suffix-export-nested-secret tool --export-nested-sibling",
        expected: "export DB_PASSWORD[foo[bar]]=[redacted] tool --export-nested-sibling",
      },
      {
        source: "export DB_PASSWORD+=suffix-export-append-secret tool --export-append-sibling",
        expected: "export DB_PASSWORD+=[redacted] tool --export-append-sibling",
      },
    ];
    for (const { source, expected } of cases) {
      const redacted = redactTraceData(source);
      expect(redacted).toBe(expected);
      expect(redacted).not.toContain("secret");
      expect(redactTraceData(redacted)).toBe(redacted);
    }

    const emptyThenSibling = "DB_PASSWORD=\nprintf 'next-line-sibling\\n'";
    expect(redactTraceData(emptyThenSibling)).toBe(emptyThenSibling);

    for (const malformed of [
      "DB_PASSWORD[foo[bar]=suffix-malformed-nested-secret\nnext-malformed-sibling",
      `export DB_PASSWORD["unterminated]=suffix-malformed-quoted-secret\nnext-malformed-quoted-sibling`,
    ]) {
      const redacted = redactTraceData(malformed);
      expect(redacted).not.toContain("secret");
      expect(redacted).not.toContain("next-malformed");
      expect(redactTraceData(redacted)).toBe(redacted);
    }

    const complexReference = `reference=\${DB_PASSWORD[$(printf 1)]} next-reference-sibling`;
    expect(redactTraceData(complexReference)).toBe(complexReference);

    const complexComparison = "if [[ $DB_PASSWORD[$(printf 1)] = expected ]]; then print comparison-sibling; fi";
    expect(redactTraceData(complexComparison)).toBe(complexComparison);

    const complexDisplay = `print -- "$DB_PASSWORD[$(printf 1)] = semantic-display-sibling"`;
    expect(redactTraceData(complexDisplay)).toBe(complexDisplay);

    const quotedReferenceEquals = `print -- "$DB_PASSWORD[$(printf 1)]=semantic-quoted-equals-sibling"`;
    expect(redactTraceData(quotedReferenceEquals)).toBe(quotedReferenceEquals);

    const unquotedReferenceEquals = "print -- $DB_PASSWORD[$(printf 1)]=semantic-unquoted-equals-sibling";
    expect(redactTraceData(unquotedReferenceEquals)).toBe(unquotedReferenceEquals);

    const complexAssignment = "DB_PASSWORD[$(printf 1)]=suffix-complex-assignment-secret\nnext-complex-sibling";
    const complexAssignmentRedacted = redactTraceData(complexAssignment);
    expect(complexAssignmentRedacted).toBe("DB_PASSWORD=[redacted]");
    expect(redactTraceData(complexAssignmentRedacted)).toBe(complexAssignmentRedacted);

    for (const { source, expected } of [
      {
        source: "printf before; DB_PASSWORD[$(printf 0)]=suffix-bash-boundary-secret; printf bash-boundary-sibling",
        expected: "printf before; credential=[redacted]",
      },
      {
        source: "printf before; DB_PASSWORD[$(printf 1)]=suffix-zsh-boundary-secret; printf zsh-boundary-sibling",
        expected: "printf before; credential=[redacted]",
      },
      {
        source: "typeset DB_PASSWORD[$(printf 1)]=suffix-zsh-typeset-secret; printf zsh-typeset-sibling",
        expected: "typeset DB_PASSWORD=[redacted]",
      },
    ]) {
      const redacted = redactTraceData(source);
      expect(redacted).toBe(expected);
      expect(redacted).not.toContain("secret");
      expect(redactTraceData(redacted)).toBe(redacted);
    }

    for (const { source, expected } of [
      {
        source: "declare -a DB_PASSWORD; declare 'DB_PASSWORD[$(printf 0)]'=suffix-bash-split-secret; printf bash-split-sibling",
        expected: "declare -a DB_PASSWORD; declare DB_PASSWORD=[redacted]",
      },
      {
        source: "typeset -A DB_PASSWORD; typeset 'DB_PASSWORD[$(printf key)]'=suffix-zsh-split-secret; print zsh-split-sibling",
        expected: "typeset -A DB_PASSWORD; typeset DB_PASSWORD=[redacted]",
      },
      {
        source: "export 'DB_PASSWORD[$(printf 1)]'=suffix-zsh-export-split-secret; print zsh-export-sibling",
        expected: "export DB_PASSWORD=[redacted]",
      },
      {
        source: "readonly 'DB_PASSWORD[$(printf 0)]'=suffix-bash-readonly-split-secret; printf bash-readonly-sibling",
        expected: "readonly DB_PASSWORD=[redacted]",
      },
      {
        source: "f() { local -a DB_PASSWORD; local 'DB_PASSWORD[$(printf 0)]'=suffix-bash-local-split-secret; printf bash-local-sibling; }; f",
        expected: "f() { local -a DB_PASSWORD; local DB_PASSWORD=[redacted]",
      },
    ]) {
      const redacted = redactTraceData(source);
      expect(redacted).toBe(expected);
      expect(redacted).not.toContain("secret");
      expect(redactTraceData(redacted)).toBe(redacted);
    }

    for (const { source, expected } of [
      {
        source: "export 'DB_PASSWORD'=suffix-zsh-export-scalar-secret; print zsh-export-scalar-sibling",
        expected: "export DB_PASSWORD=[redacted]; print zsh-export-scalar-sibling",
      },
      {
        source: "typeset 'DB_PASSWORD'=suffix-zsh-typeset-scalar-secret; print zsh-typeset-scalar-sibling",
        expected: "typeset DB_PASSWORD=[redacted]; print zsh-typeset-scalar-sibling",
      },
      {
        source: "declare -- 'DB_PASSWORD'=suffix-bash-declare-option-secret; printf bash-declare-option-sibling",
        expected: "declare -- DB_PASSWORD=[redacted]; printf bash-declare-option-sibling",
      },
      {
        source: "typeset -- 'DB_PASSWORD'=suffix-zsh-typeset-option-secret; print zsh-typeset-option-sibling",
        expected: "typeset -- DB_PASSWORD=[redacted]; print zsh-typeset-option-sibling",
      },
      {
        source: "declare +x 'DB_PASSWORD'=suffix-bash-plus-option-secret; printf bash-plus-option-sibling",
        expected: "declare +x DB_PASSWORD=[redacted]; printf bash-plus-option-sibling",
      },
      {
        source: "f() { export 'DB_PASSWORD'=suffix-zsh-group-secret; print zsh-group-sibling; }; f",
        expected: "f() { export DB_PASSWORD=[redacted]; print zsh-group-sibling; }; f",
      },
      {
        source: "( export 'DB_PASSWORD'=suffix-zsh-subshell-secret; print zsh-subshell-sibling )",
        expected: "( export DB_PASSWORD=[redacted]; print zsh-subshell-sibling )",
      },
      {
        source: "print pipeline | export 'DB_PASSWORD'=suffix-zsh-pipeline-secret; print zsh-pipeline-sibling",
        expected: "print pipeline | export DB_PASSWORD=[redacted]; print zsh-pipeline-sibling",
      },
      {
        source: "builtin export 'DB_PASSWORD'=suffix-zsh-builtin-secret; print zsh-builtin-sibling",
        expected: "builtin export DB_PASSWORD=[redacted]; print zsh-builtin-sibling",
      },
      {
        source: "command -p export 'DB_PASSWORD'=suffix-zsh-command-secret; print zsh-command-sibling",
        expected: "command -p export DB_PASSWORD=[redacted]; print zsh-command-sibling",
      },
      {
        source: "if true; then export 'DB_PASSWORD'=suffix-zsh-then-secret; print zsh-then-sibling; fi",
        expected: "if true; then export DB_PASSWORD=[redacted]; print zsh-then-sibling; fi",
      },
      {
        source: "env 'DB_PASSWORD'=suffix-bash-env-secret /usr/bin/true; printf bash-env-sibling",
        expected: "env DB_PASSWORD=[redacted] /usr/bin/true; printf bash-env-sibling",
      },
      {
        source: "env -i 'DB_PASSWORD'=suffix-zsh-env-option-secret /usr/bin/true; print zsh-env-option-sibling",
        expected: "env -i DB_PASSWORD=[redacted] /usr/bin/true; print zsh-env-option-sibling",
      },
      {
        source: "case x in x) export 'DB_PASSWORD'=suffix-zsh-case-secret; print zsh-case-sibling;; esac",
        expected: "case x in x) export DB_PASSWORD=[redacted]; print zsh-case-sibling;; esac",
      },
      {
        source: "true & export 'DB_PASSWORD'=suffix-zsh-background-secret; print zsh-background-sibling; wait",
        expected: "true & export DB_PASSWORD=[redacted]; print zsh-background-sibling; wait",
      },
      {
        source: "if export 'DB_PASSWORD[$(printf 1)]'=suffix-zsh-if-secret; then print zsh-if-sibling; fi",
        expected: "if export DB_PASSWORD=[redacted]",
      },
      {
        source: "while export 'DB_PASSWORD[$(printf 1)]'=suffix-zsh-while-secret; do print zsh-while-sibling; break; done",
        expected: "while export DB_PASSWORD=[redacted]",
      },
      {
        source: "until export 'DB_PASSWORD[$(printf 1)]'=suffix-zsh-until-secret; do print zsh-until-sibling; done",
        expected: "until export DB_PASSWORD=[redacted]",
      },
      {
        source: "time export 'DB_PASSWORD'=suffix-zsh-time-secret; print zsh-time-sibling",
        expected: "time export DB_PASSWORD=[redacted]; print zsh-time-sibling",
      },
      {
        source: "noglob export 'DB_PASSWORD'=suffix-zsh-noglob-secret; print zsh-noglob-sibling",
        expected: "noglob export DB_PASSWORD=[redacted]; print zsh-noglob-sibling",
      },
      {
        source: "env -u OLD_VALUE 'DB_PASSWORD'=suffix-bash-env-unset-secret /usr/bin/true; printf bash-env-unset-sibling",
        expected: "env -u OLD_VALUE DB_PASSWORD=[redacted] /usr/bin/true; printf bash-env-unset-sibling",
      },
      {
        source: "env -P /usr/bin 'DB_PASSWORD'=suffix-zsh-env-path-secret true; print zsh-env-path-sibling",
        expected: "env -P /usr/bin DB_PASSWORD=[redacted] true; print zsh-env-path-sibling",
      },
      {
        source: "/usr/bin/env 'DB_PASSWORD'=suffix-absolute-env-secret /usr/bin/true; print absolute-env-sibling",
        expected: "/usr/bin/env DB_PASSWORD=[redacted] /usr/bin/true; print absolute-env-sibling",
      },
      {
        source: "/bin/env 'DB_PASSWORD'=suffix-bin-env-secret /usr/bin/true; print bin-env-sibling",
        expected: "/bin/env DB_PASSWORD=[redacted] /usr/bin/true; print bin-env-sibling",
      },
      {
        source: "nocorrect export 'DB_PASSWORD'=suffix-zsh-nocorrect-secret; print zsh-nocorrect-sibling",
        expected: "nocorrect export DB_PASSWORD=[redacted]; print zsh-nocorrect-sibling",
      },
      {
        source: "env -iv 'DB_PASSWORD'=suffix-macos-env-combined-secret /usr/bin/true; print macos-env-combined-sibling",
        expected: "env -iv DB_PASSWORD=[redacted] /usr/bin/true; print macos-env-combined-sibling",
      },
      {
        source: "env -uPATH 'DB_PASSWORD'=suffix-macos-env-attached-unset-secret /usr/bin/true; print macos-env-attached-unset-sibling",
        expected: "env -uPATH DB_PASSWORD=[redacted] /usr/bin/true; print macos-env-attached-unset-sibling",
      },
      {
        source: "env -P/usr/bin 'DB_PASSWORD'=suffix-macos-env-attached-path-secret true; print macos-env-attached-path-sibling",
        expected: "env -P/usr/bin DB_PASSWORD=[redacted] true; print macos-env-attached-path-sibling",
      },
      {
        source: "env -ivuOLD_VALUE 'DB_PASSWORD'=suffix-macos-env-cluster-attached-secret /usr/bin/true; print macos-env-cluster-attached-sibling",
        expected: "env -ivuOLD_VALUE DB_PASSWORD=[redacted] /usr/bin/true; print macos-env-cluster-attached-sibling",
      },
      {
        source: "env -iu OLD_VALUE 'DB_PASSWORD'=suffix-macos-env-cluster-next-secret /usr/bin/true; print macos-env-cluster-next-sibling",
        expected: "env -iu OLD_VALUE DB_PASSWORD=[redacted] /usr/bin/true; print macos-env-cluster-next-sibling",
      },
      {
        source: "env -ivP/usr/bin 'DB_PASSWORD'=suffix-macos-env-cluster-path-secret true; print macos-env-cluster-path-sibling",
        expected: "env -ivP/usr/bin DB_PASSWORD=[redacted] true; print macos-env-cluster-path-sibling",
      },
      {
        source: "/usr/bin/env -P '/usr/bin' 'DB_PASSWORD'=suffix-macos-env-quoted-path-secret true; print macos-env-quoted-path-sibling",
        expected: "/usr/bin/env -P '/usr/bin' DB_PASSWORD=[redacted] true; print macos-env-quoted-path-sibling",
      },
      {
        source: "env -C '/tmp' 'DB_PASSWORD'=suffix-macos-env-quoted-chdir-secret /usr/bin/true; print macos-env-quoted-chdir-sibling",
        expected: "env -C '/tmp' DB_PASSWORD=[redacted] /usr/bin/true; print macos-env-quoted-chdir-sibling",
      },
      {
        source: "env -u 'OLD_VALUE' 'DB_PASSWORD'=suffix-macos-env-quoted-unset-secret /usr/bin/true; print macos-env-quoted-unset-sibling",
        expected: "env -u 'OLD_VALUE' DB_PASSWORD=[redacted] /usr/bin/true; print macos-env-quoted-unset-sibling",
      },
      {
        source: `env -P "$(printf /usr/bin)" 'DB_PASSWORD'=suffix-complex-option-secret /usr/bin/true; print complex-option-sibling`,
        expected: `env -P "$(printf /usr/bin)" DB_PASSWORD=[redacted]`,
      },
      {
        source: `time env -P "$(printf /usr/bin)" 'DB_PASSWORD'=suffix-time-complex-option-secret /usr/bin/true; print time-complex-option-sibling`,
        expected: `time env -P "$(printf /usr/bin)" DB_PASSWORD=[redacted]`,
      },
      {
        source: `noglob env -u "$(printf OLD_VALUE)" 'DB_PASSWORD'=suffix-noglob-complex-option-secret /usr/bin/true; print noglob-complex-option-sibling`,
        expected: `noglob env -u "$(printf OLD_VALUE)" DB_PASSWORD=[redacted]`,
      },
      {
        source: `nocorrect env -u "$(printf OLD_VALUE)" 'DB_PASSWORD'=suffix-nocorrect-complex-option-secret /usr/bin/true; print nocorrect-complex-option-sibling`,
        expected: `nocorrect env -u "$(printf OLD_VALUE)" DB_PASSWORD=[redacted]`,
      },
      {
        source: `env -P "$(printf /usr/bin)" SAFE_VALUE=visible 'DB_PASSWORD'=suffix-intervening-assignment-secret /usr/bin/true; print intervening-assignment-sibling`,
        expected: `env -P "$(printf /usr/bin)" SAFE_VALUE=visible DB_PASSWORD=[redacted]`,
      },
      {
        source: `/usr/bin/env '-i' 'DB_PASSWORD=suffix-quoted-env-word-secret' /usr/bin/true; print quoted-env-word-sibling`,
        expected: `/usr/bin/env '-i' DB_PASSWORD=[redacted] /usr/bin/true; print quoted-env-word-sibling`,
      },
      {
        source: `env '-i' 'SAFE_VALUE=visible' 'DB_PASSWORD=suffix-quoted-safe-assignment-secret' /usr/bin/true; print quoted-safe-assignment-sibling`,
        expected: `env '-i' 'SAFE_VALUE=visible' DB_PASSWORD=[redacted] /usr/bin/true; print quoted-safe-assignment-sibling`,
      },
      {
        source: `env -P "$(printf /usr/bin)" 'DB_PASSWORD=suffix-complex-quoted-word-secret' /usr/bin/true; print complex-quoted-word-sibling`,
        expected: `env -P "$(printf /usr/bin)" DB_PASSWORD=[redacted]`,
      },
      {
        source: `env SAFE_VALUE=$(printf visible) 'DB_PASSWORD'=suffix-dynamic-assignment-secret /usr/bin/true; print dynamic-assignment-sibling`,
        expected: `env SAFE_VALUE=$(printf visible) DB_PASSWORD=[redacted]`,
      },
      {
        source: `SOURCE=SAFE_VALUE=visible; env $SOURCE 'DB_PASSWORD'=suffix-dynamic-source-secret /usr/bin/true; print dynamic-source-sibling`,
        expected: `SOURCE=SAFE_VALUE=visible; env credential=[redacted]`,
      },
      {
        source: `env "$(printf SAFE_VALUE=visible)" 'DB_PASSWORD'=suffix-quoted-dynamic-assignment-secret /usr/bin/true; print quoted-dynamic-assignment-sibling`,
        expected: `env credential=[redacted]`,
      },
      {
        source: `env 'SAFE_VALUE=; env ' 'DB_PASSWORD'=suffix-single-fake-boundary-secret /usr/bin/true; print single-fake-boundary-sibling`,
        expected: `env 'SAFE_VALUE=; env ' DB_PASSWORD=[redacted] /usr/bin/true; print single-fake-boundary-sibling`,
      },
      {
        source: `env "SAFE_VALUE=; env " 'DB_PASSWORD'=suffix-double-fake-boundary-secret /usr/bin/true; print double-fake-boundary-sibling`,
        expected: `env "SAFE_VALUE=; env " DB_PASSWORD=[redacted] /usr/bin/true; print double-fake-boundary-sibling`,
      },
      {
        source: `env SAFE_VALUE="$(printf '; env ')" 'DB_PASSWORD'=suffix-substitution-fake-boundary-secret /usr/bin/true; print substitution-fake-boundary-sibling`,
        expected: `env SAFE_VALUE="$(printf '; env ')" DB_PASSWORD=[redacted]`,
      },
      {
        source: `env SAFE_VALUE=one /usr/bin/true; env SAFE_VALUE=two 'DB_PASSWORD'=suffix-second-real-env-secret /usr/bin/true; print second-real-env-sibling`,
        expected: `env SAFE_VALUE=one /usr/bin/true; env SAFE_VALUE=two DB_PASSWORD=[redacted] /usr/bin/true; print second-real-env-sibling`,
      },
      {
        source: `exec env DB_PASSWORD=suffix-exec-standard-secret /usr/bin/true`,
        expected: `exec env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `exec env 'DB_PASSWORD'=suffix-exec-split-lhs-secret /usr/bin/true`,
        expected: `exec env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `exec /usr/bin/env '1DB_PASSWORD=suffix-exec-arbitrary-secret' /usr/bin/true`,
        expected: `exec /usr/bin/env 1DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `exec -c env 'DB_PASSWORD'=suffix-exec-clear-secret /usr/bin/true`,
        expected: `exec -c env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `exec -a relayer env 'DB_PASSWORD'=suffix-exec-argv-zero-secret /usr/bin/true`,
        expected: `exec -a relayer env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `exec -cl -a relayer -- env 'DB_PASSWORD'=suffix-exec-cluster-secret /usr/bin/true`,
        expected: `exec -cl -a relayer -- env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `exec -arel env 'DB_PASSWORD'=suffix-exec-attached-secret /usr/bin/true`,
        expected: `exec -arel env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `exec -claREL env 'DB_PASSWORD'=suffix-bash-exec-cluster-secret /usr/bin/true`,
        expected: `exec -claREL env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `coproc env 'DB_PASSWORD'=suffix-coproc-secret /usr/bin/true`,
        expected: `coproc env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `nohup env 'DB_PASSWORD'=suffix-nohup-secret /usr/bin/true`,
        expected: `nohup env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/nohup /usr/bin/env 'DB_PASSWORD'=suffix-absolute-nohup-secret /usr/bin/true`,
        expected: `/usr/bin/nohup /usr/bin/env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `nice env 'DB_PASSWORD'=suffix-nice-secret /usr/bin/true`,
        expected: `nice env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/nice -n 5 /usr/bin/env '1DB_PASSWORD=suffix-nice-arbitrary-secret' /usr/bin/true`,
        expected: `/usr/bin/nice -n 5 /usr/bin/env 1DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/nice -5 env 'DB_PASSWORD'=suffix-nice-short-secret /usr/bin/true`,
        expected: `/usr/bin/nice -5 env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/time -p env 'DB_PASSWORD'=suffix-external-time-secret /usr/bin/true`,
        expected: `/usr/bin/time -p env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `caffeinate -dimsu env 'DB_PASSWORD'=suffix-caffeinate-secret /usr/bin/true`,
        expected: `caffeinate -dimsu env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/caffeinate -t 1 /usr/bin/env '1DB_PASSWORD=suffix-caffeinate-arbitrary-secret' /usr/bin/true`,
        expected: `/usr/bin/caffeinate -t 1 /usr/bin/env 1DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/caffeinate -t1 env 'DB_PASSWORD'=suffix-caffeinate-attached-timeout-secret /usr/bin/true`,
        expected: `/usr/bin/caffeinate -t1 env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `caffeinate -it1 env 'DB_PASSWORD'=suffix-caffeinate-cluster-timeout-secret /usr/bin/true`,
        expected: `caffeinate -it1 env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `caffeinate -w$$ /usr/bin/env '1DB_PASSWORD=suffix-caffeinate-attached-pid-secret' /usr/bin/true`,
        expected: `caffeinate -w$$ /usr/bin/env 1DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `time -p env 'DB_PASSWORD'=suffix-bash-time-posix-secret /usr/bin/true`,
        expected: `time -p env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `exec -cla env 'DB_PASSWORD'=suffix-malformed-exec-option-secret /usr/bin/true; print malformed-exec-option-sibling`,
        expected: `exec -cla env DB_PASSWORD=[redacted]`,
      },
      {
        source: String.raw`\exec env 'DB_PASSWORD'=suffix-escaped-exec-secret /usr/bin/true`,
        expected: String.raw`\exec env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: String.raw`e\xec env 'DB_PASSWORD'=suffix-inner-escaped-exec-secret /usr/bin/true`,
        expected: String.raw`e\xec env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: String.raw`ex\
ec env 'DB_PASSWORD'=suffix-continuation-exec-secret /usr/bin/true`,
        expected: String.raw`ex\
ec env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: String.raw`\time env 'DB_PASSWORD'=suffix-escaped-time-secret /usr/bin/true`,
        expected: String.raw`\time env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: String.raw`\nice env 'DB_PASSWORD'=suffix-escaped-nice-secret /usr/bin/true`,
        expected: String.raw`\nice env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: String.raw`\caffeinate env 'DB_PASSWORD'=suffix-escaped-caffeinate-secret /usr/bin/true`,
        expected: String.raw`\caffeinate env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: String.raw`/usr/bin/ti\
me -p env 'DB_PASSWORD'=suffix-continuation-absolute-time-secret /usr/bin/true`,
        expected: String.raw`/usr/bin/ti\
me -p env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: String.raw`exec e\
nv '1DB_PASSWORD=suffix-continuation-env-secret' /usr/bin/true`,
        expected: String.raw`exec e\
nv 1DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/time -o/tmp/relayer-time-output env 'DB_PASSWORD'=suffix-time-attached-output-secret /usr/bin/true`,
        expected: `/usr/bin/time -o/tmp/relayer-time-output env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/time -ao/tmp/relayer-time-output env 'DB_PASSWORD'=suffix-time-clustered-output-secret /usr/bin/true`,
        expected: `/usr/bin/time -ao/tmp/relayer-time-output env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `caffeinate -t+1 env 'DB_PASSWORD'=suffix-caffeinate-plus-timeout-secret /usr/bin/true`,
        expected: `caffeinate -t+1 env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `command '--' env 'DB_PASSWORD'=suffix-command-quoted-option-secret /usr/bin/true`,
        expected: `command '--' env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `exec '-c' env 'DB_PASSWORD'=suffix-exec-quoted-option-secret /usr/bin/true`,
        expected: `exec '-c' env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/time '-p' env 'DB_PASSWORD'=suffix-time-quoted-option-secret /usr/bin/true`,
        expected: `/usr/bin/time '-p' env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `/usr/bin/time '-o/tmp/relayer-time-output' env 'DB_PASSWORD'=suffix-time-quoted-attached-option-secret /usr/bin/true`,
        expected: `/usr/bin/time '-o/tmp/relayer-time-output' env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `nice '-n' 5 env 'DB_PASSWORD'=suffix-nice-quoted-option-secret /usr/bin/true`,
        expected: `nice '-n' 5 env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `caffeinate '-t' 1 env 'DB_PASSWORD'=suffix-caffeinate-quoted-option-secret /usr/bin/true`,
        expected: `caffeinate '-t' 1 env DB_PASSWORD=[redacted] /usr/bin/true`,
      },
      {
        source: `env SAFE_INPUT=<(printf '; env ') 'DB_PASSWORD'=suffix-input-process-secret /usr/bin/true; print input-process-sibling`,
        expected: `env SAFE_INPUT=<(printf '; env ') DB_PASSWORD=[redacted] /usr/bin/true; print input-process-sibling`,
      },
      {
        source: `env SAFE_OUTPUT=>(printf '; env ') 'DB_PASSWORD'=suffix-output-process-secret /usr/bin/true; print output-process-sibling`,
        expected: `env SAFE_OUTPUT=>(printf '; env ') DB_PASSWORD=[redacted] /usr/bin/true; print output-process-sibling`,
      },
      {
        source: `print '😀'; env SAFE_VALUE=emoji 'DB_PASSWORD'=suffix-emoji-standard-secret /usr/bin/true; print emoji-standard-sibling`,
        expected: `print '😀'; env SAFE_VALUE=emoji DB_PASSWORD=[redacted] /usr/bin/true; print emoji-standard-sibling`,
      },
      {
        source: `print '😀'; env SAFE_VALUE=emoji '1DB_PASSWORD=suffix-emoji-arbitrary-secret' /usr/bin/true; print emoji-arbitrary-sibling`,
        expected: `print '😀'; env SAFE_VALUE=emoji 1DB_PASSWORD=[redacted] /usr/bin/true; print emoji-arbitrary-sibling`,
      },
      {
        source: `env SAFE_VALUE="$(case x in x) printf '; env ';; esac)" 'DB_PASSWORD'=suffix-case-fake-env-secret /usr/bin/true; print case-fake-env-sibling`,
        expected: `env SAFE_VALUE="$(case x in x) printf '; env ';; esac)" DB_PASSWORD=[redacted]`,
      },
      {
        source: `env SAFE_VALUE="$(cat <<'EOF'\n; env \nEOF\n)" 'DB_PASSWORD'=suffix-heredoc-fake-env-secret /usr/bin/true; print heredoc-fake-env-sibling`,
        expected: `env SAFE_VALUE="$(cat <<'EOF'\n; env \nEOF\n)" DB_PASSWORD=[redacted]`,
      },
      {
        source: `env SAFE-VALUE=visible 'DB_PASSWORD'=suffix-hyphenated-env-name-secret /usr/bin/true; print hyphenated-env-name-sibling`,
        expected: `env SAFE-VALUE=visible DB_PASSWORD=[redacted] /usr/bin/true; print hyphenated-env-name-sibling`,
      },
      {
        source: `env 1SAFE=visible 'DB_PASSWORD'=suffix-digit-env-name-secret /usr/bin/true; print digit-env-name-sibling`,
        expected: `env 1SAFE=visible DB_PASSWORD=[redacted] /usr/bin/true; print digit-env-name-sibling`,
      },
      {
        source: `env SAFE-VALUE=$(printf visible) 'DB_PASSWORD'=suffix-dynamic-hyphenated-env-name-secret /usr/bin/true; print dynamic-hyphenated-env-name-sibling`,
        expected: `env SAFE-VALUE=$(printf visible) DB_PASSWORD=[redacted]`,
      },
      {
        source: `env 1DB_PASSWORD=suffix-digit-credential-name-secret /usr/bin/true; print digit-credential-name-sibling`,
        expected: `env 1DB_PASSWORD=[redacted] /usr/bin/true; print digit-credential-name-sibling`,
      },
      {
        source: `env 'DB.PASSWORD=suffix-dot-credential-name-secret' /usr/bin/true; print dot-credential-name-sibling`,
        expected: `env DB.PASSWORD=[redacted] /usr/bin/true; print dot-credential-name-sibling`,
      },
      {
        source: `env -- '-DB_PASSWORD=suffix-leading-dash-credential-name-secret' /usr/bin/true; print leading-dash-credential-name-sibling`,
        expected: `env -- -DB_PASSWORD=[redacted] /usr/bin/true; print leading-dash-credential-name-sibling`,
      },
      {
        source: `env 'DB PASSWORD=suffix-space-credential-name-secret' /usr/bin/true; print space-credential-name-sibling`,
        expected: `env DB PASSWORD=[redacted] /usr/bin/true; print space-credential-name-sibling`,
      },
      {
        source: `env "DB.PASSWORD=$(printf suffix-complex-arbitrary-name-secret)" /usr/bin/true; print complex-arbitrary-name-sibling`,
        expected: `env DB.PASSWORD=[redacted]`,
      },
      {
        source: `/usr/bin/env "DB_$(printf PASSWORD)=suffix-dynamic-name-secret" /usr/bin/true; print dynamic-name-sibling`,
        expected: `/usr/bin/env credential=[redacted]`,
      },
      {
        source: `env "$(printf DB_PASSWORD)=suffix-fully-dynamic-name-secret" /usr/bin/true; print fully-dynamic-name-sibling`,
        expected: `env credential=[redacted]`,
      },
      {
        source: `env "$(printf DB_PASSWORD=suffix-fully-dynamic-word-secret)" /usr/bin/true; print fully-dynamic-word-sibling`,
        expected: `env credential=[redacted]`,
      },
      {
        source: `env "$(printf 'DB_PASSWORD=%s' suffix-formatted-dynamic-word-secret)" /usr/bin/true; print formatted-dynamic-word-sibling`,
        expected: `env credential=[redacted]`,
      },
      {
        source: "env \"`printf DB_PASSWORD=suffix-backtick-dynamic-word-secret`\" /usr/bin/true; print backtick-dynamic-word-sibling",
        expected: `env credential=[redacted]`,
      },
      {
        source: `/usr/bin/env "$(printf DB_)$(printf PASS)$(printf WORD=suffix-split-name-secret)" /usr/bin/printenv DB_PASSWORD; print split-name-sibling`,
        expected: `/usr/bin/env credential=[redacted]`,
      },
      {
        source: `/usr/bin/env "$(printf 'DB_PASSWORD\\075suffix-octal-secret')" /usr/bin/printenv DB_PASSWORD; print octal-separator-sibling`,
        expected: `/usr/bin/env credential=[redacted]`,
      },
      {
        source: `env "DB_PASSWORD$(printf '\\075')suffix-split-separator-secret" /usr/bin/printenv DB_PASSWORD; print split-separator-sibling`,
        expected: `env credential=[redacted]`,
      },
      {
        source: `SEP='='; env "DB_PASSWORD\${SEP}suffix-expanded-separator-secret" /usr/bin/printenv DB_PASSWORD; print expanded-separator-sibling`,
        expected: `SEP='='; env credential=[redacted]`,
      },
      {
        source: `env "$(printf SAFE_VALUE)" /usr/bin/true; print benign-unresolved-preutility-sibling`,
        expected: `env credential=[redacted]`,
      },
      {
        source: "env - 'DB_PASSWORD'=suffix-macos-env-lone-dash-secret /usr/bin/true; print macos-env-lone-dash-sibling",
        expected: "env - DB_PASSWORD=[redacted] /usr/bin/true; print macos-env-lone-dash-sibling",
      },
    ]) {
      const redacted = redactTraceData(source);
      expect(redacted).toBe(expected);
      expect(redacted).not.toContain("secret");
      expect(redactTraceData(redacted)).toBe(redacted);
    }

    const longSafePrefix = Array.from({ length: 96 }, (_, index) => `SAFE_${index}=visible-${index}`).join(" ");
    for (const { source, expected } of [
      {
        source: `env ${longSafePrefix} 'DB_PASSWORD'=suffix-long-prefix-secret /usr/bin/true; print long-prefix-sibling`,
        expected: `env ${longSafePrefix} DB_PASSWORD=[redacted] /usr/bin/true; print long-prefix-sibling`,
      },
      {
        source: `env ${longSafePrefix} '1DB_PASSWORD=suffix-long-prefix-arbitrary-secret' /usr/bin/true; print long-prefix-arbitrary-sibling`,
        expected: `env ${longSafePrefix} 1DB_PASSWORD=[redacted] /usr/bin/true; print long-prefix-arbitrary-sibling`,
      },
    ]) {
      expect(source.indexOf("DB_PASSWORD")).toBeGreaterThan(1_024);
      const redacted = redactTraceData(source);
      expect(redacted).toBe(expected);
      expect(redacted).not.toContain("secret");
      expect(redactTraceData(redacted)).toBe(redacted);
    }

    const overBudgetSafePrefix = Array.from({ length: 1_100 }, (_, index) => `SAFE_${index}=visible-${index}`).join(" ");
    const overBudget = `env ${overBudgetSafePrefix} '1DB_PASSWORD=suffix-over-budget-secret' /usr/bin/true; print over-budget-sibling`;
    expect(overBudget.indexOf("1DB_PASSWORD")).toBeGreaterThan(16_384);
    const overBudgetRedacted = redactTraceData(overBudget);
    expect(overBudgetRedacted).toBe(`env ${overBudgetSafePrefix} 1DB_PASSWORD=[redacted]`);
    expect(overBudgetRedacted).not.toContain("secret");
    expect(redactTraceData(overBudgetRedacted)).toBe(overBudgetRedacted);

    const overBudgetFakeBoundary = `env ${overBudgetSafePrefix} 'SAFE_FAKE=; env ' 'DB_PASSWORD=suffix-over-budget-fake-boundary-secret' /usr/bin/true; print over-budget-fake-boundary-sibling`;
    const overBudgetFakeBoundaryRedacted = redactTraceData(overBudgetFakeBoundary);
    expect(overBudgetFakeBoundaryRedacted).toBe(`env ${overBudgetSafePrefix} 'SAFE_FAKE=; env ' DB_PASSWORD=[redacted]`);
    expect(overBudgetFakeBoundaryRedacted).not.toContain("secret");
    expect(redactTraceData(overBudgetFakeBoundaryRedacted)).toBe(overBudgetFakeBoundaryRedacted);

    const overBudgetComplexBoundary = `env ${overBudgetSafePrefix} SAFE_COMPLEX="$(case x in x) printf '; env ';; esac)" 'DB_PASSWORD=suffix-over-budget-complex-boundary-secret' /usr/bin/true; print over-budget-complex-boundary-sibling`;
    const overBudgetComplexBoundaryRedacted = redactTraceData(overBudgetComplexBoundary);
    expect(overBudgetComplexBoundaryRedacted).toBe(`env ${overBudgetSafePrefix} SAFE_COMPLEX="$(case x in x) printf '; env ';; esac)" DB_PASSWORD=[redacted]`);
    expect(overBudgetComplexBoundaryRedacted).not.toContain("secret");
    expect(redactTraceData(overBudgetComplexBoundaryRedacted)).toBe(overBudgetComplexBoundaryRedacted);

    for (const source of [
      `env -i printf '%s\\n' 'DB_PASSWORD'=semantic-safe-child-argument; print safe-child-later-sibling`,
      `env -P "$(printf /usr/bin)" printf '%s\\n' 'DB_PASSWORD'=semantic-complex-child-argument; print complex-child-later-sibling`,
      `/usr/bin/env '-i' printf '%s\\n' 'DB_PASSWORD=semantic-quoted-child-argument'; print quoted-child-later-sibling`,
      `env printf '%s\\n' "$(printf SAFE_VALUE=visible)" 'DB_PASSWORD=semantic-dynamic-child-argument'; print dynamic-child-later-sibling`,
      `env printf '%s\\n' SAFE-VALUE=semantic 'DB_PASSWORD=semantic-nonidentifier-child-argument'; print nonidentifier-child-later-sibling`,
      `env '=invalid-empty-name' 'DB_PASSWORD=semantic-after-invalid-name'; print invalid-name-later-sibling`,
      `env printf '%s\\n' '1DB_PASSWORD=semantic-arbitrary-child-argument'; print arbitrary-child-later-sibling`,
      `env printf '%s\\n' "$(printf DB_PASSWORD)=semantic-dynamic-name-child"; print dynamic-name-child-later-sibling`,
      `env printf '%s\\n' "$(printf 'DB_PASSWORD=%s' semantic-dynamic-word-child)"; print dynamic-word-child-later-sibling`,
      `exec env printf '%s\\n' 'DB_PASSWORD=semantic-exec-child-argument'`,
      `coproc env printf '%s\\n' 'DB_PASSWORD=semantic-coproc-child-argument'`,
      `nohup env printf '%s\\n' 'DB_PASSWORD=semantic-nohup-child-argument'`,
      `nice env printf '%s\\n' 'DB_PASSWORD=semantic-nice-child-argument'`,
      `/usr/bin/time -p env printf '%s\\n' 'DB_PASSWORD=semantic-time-child-argument'`,
      `caffeinate -t 1 env printf '%s\\n' 'DB_PASSWORD=semantic-caffeinate-child-argument'`,
      `/usr/bin/time -o/tmp/relayer-time-output env printf '%s\\n' 'DB_PASSWORD=semantic-time-attached-child'; print time-attached-child-sibling`,
      `/usr/bin/time -ao/tmp/relayer-time-output env printf '%s\\n' 'DB_PASSWORD=semantic-time-clustered-child'; print time-clustered-child-sibling`,
      `caffeinate -t+1 env printf '%s\\n' 'DB_PASSWORD=semantic-caffeinate-plus-child'; print caffeinate-plus-child-sibling`,
      `command '--' env printf '%s\\n' 'DB_PASSWORD=semantic-command-quoted-option-child'; print command-quoted-option-child-sibling`,
      `exec '-c' env printf '%s\\n' 'DB_PASSWORD=semantic-exec-quoted-option-child'; print exec-quoted-option-child-sibling`,
      `/usr/bin/time '-p' env printf '%s\\n' 'DB_PASSWORD=semantic-time-quoted-option-child'; print time-quoted-option-child-sibling`,
      `nice '-n' 5 env printf '%s\\n' 'DB_PASSWORD=semantic-nice-quoted-option-child'; print nice-quoted-option-child-sibling`,
      `caffeinate '-t' 1 env printf '%s\\n' 'DB_PASSWORD=semantic-caffeinate-quoted-option-child'; print caffeinate-quoted-option-child-sibling`,
      `sudo env printf '%s\\n' 'DB_PASSWORD=semantic-unsupported-wrapper-child-argument'`,
    ]) {
      expect(redactTraceData(source)).toBe(source);
    }
  });

  it("records truncation and lowers achieved coverage without breaking sealing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-trace-cap-"));
    try {
      const store = new HarnessTraceStore({ directory, policy: policy({ maxEventsPerTurn: 2 }) });
      const active = store.start({
        threadId: 1,
        interactionNodeId: 2,
        implementation: "fixture.trace",
        configurationName: "fixture-trace",
        support: fullSupport,
      });
      active.sink.emit({ type: "message", data: { text: "discarded by the cap" } });
      const descriptor = await active.seal("complete");
      expect(descriptor.truncated).toBe(true);
      expect(descriptor.eventCount).toBeLessThanOrEqual(2);
      expect(descriptor.coverage.messages).toBe("summary");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

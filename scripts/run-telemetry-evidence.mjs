import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDesktopAuthenticatedErrorReporting } from "../desktop/main/services/authenticated-error-reporting.mjs";
import { installElectronMainErrorAdapter } from "../desktop/main/services/electron-main-error-adapter.mjs";
import { createDesktopErrorReporterIssuer } from "../desktop/main/services/authenticated-error-startup.mjs";
import { createSentryErrorTransport } from "../desktop/main/services/sentry-error-transport.mjs";

const require = createRequire(import.meta.url);
const { installRendererErrorReporting } = require("../desktop/preload/error-reporting.cjs");

const repositoryRoot = resolve(import.meta.dirname, "..");
const desktopPackage = JSON.parse(await readFile(join(repositoryRoot, "desktop/package.json"), "utf8"));
const corpusPath = join(repositoryRoot, "test/fixtures/telemetry-privacy-v1.json");
const defaultOutputPath = join(repositoryRoot, ".relayer/evidence/telemetry-v1.json");
const releaseAuthorityPaths = Object.freeze([
  "desktop/packaging/electron-builder.mjs",
  "desktop/release/build-release.mjs",
  "desktop/release/telemetry-artifacts.mjs",
  ".github/workflows/desktop-signed-preview.yml",
]);
const releaseIdentity = Object.freeze({
  release: `ai.relayer.desktop@${desktopPackage.version}+${"b".repeat(40)}`,
  environment: "preview",
  os: "macos",
  architecture: "arm64",
});
const APPROVED_EVENT_KEYS = Object.freeze([
  "environment", "event_id", "exception", "level", "release", "tags", "timestamp", "user",
]);
const productionPortfolioFiles = Object.freeze([
  "test/desktop-account-session.test.mjs",
  "test/desktop-authenticated-error-gateway.test.mjs",
  "test/desktop-authenticated-error-receiver.test.mjs",
  "test/desktop-authenticated-error-reporting.test.mjs",
  "test/desktop-authenticated-error-startup.test.mjs",
  "test/desktop-error-domain-adapters.test.mjs",
  "test/desktop-error-stack-sanitizer.test.mjs",
  "test/desktop-renderer-error-reporting.test.mjs",
  "test/desktop-rust-error-capabilities.test.mjs",
  "test/desktop-telemetry-release.test.mjs",
  "test/desktop-telemetry-release-artifacts.test.mjs",
  "test/desktop-telemetry-module-inventory.test.mjs",
  "test/sentry-error-transport.test.mjs",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`Telemetry evidence failed: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createLocalSealer() {
  const key = randomBytes(32);
  return Object.freeze({
    encrypt(plaintext) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
    },
    decrypt(sealed) {
      const bytes = Buffer.from(sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    },
  });
}

async function createLoopbackSink() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  return Object.freeze({
    dsn: `http://public@127.0.0.1:${server.address().port}/1`,
    requests,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  });
}

function mutate(record, forbidden) {
  const copy = structuredClone(record);
  if (forbidden.kind === "frame-module") {
    copy.frames = [{ ...copy.frames[0], module: forbidden.value }];
    return copy;
  }
  if (forbidden.kind === "oversized-frames") {
    copy.frames = Array.from({ length: 33 }, () => structuredClone(copy.frames[0]));
    return copy;
  }
  if (forbidden.kind === "oversized-module") {
    copy.frames = [{ ...copy.frames[0], module: `${copy.frames[0].module}${"x".repeat(257)}` }];
    return copy;
  }
  copy[forbidden.field] = structuredClone(forbidden.value);
  return copy;
}

async function submit(capability, record) {
  const response = await fetch(capability.endpoint, {
    method: "POST",
    headers: { authorization: capability.authorization, "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

function adapterStack(component, forbidden) {
  const detail = JSON.stringify(forbidden.value ?? forbidden.id);
  const defaults = {
    renderer: "http://127.0.0.1:43120/src/main.js",
    "electron-main": "/sealed-source/desktop/main/index.mjs",
    "node-harness-host": "/sealed-source/packages/harness-host/dist/host.js",
  };
  let locations = [defaults[component]];
  if (forbidden.kind === "frame-module") {
    const value = forbidden.value;
    if (component === "renderer") {
      locations = value.startsWith("desktop/renderer/")
        ? [`http://127.0.0.1:43120/${value.slice("desktop/renderer/".length)}`]
        : [value];
    } else if (component === "electron-main") {
      locations = value.startsWith("desktop/main/") ? [`/sealed-source/${value}`] : [defaults[component]];
    } else {
      locations = [
        ...(value.startsWith("packages/harness-host/") ? [`/sealed-source/${value}`] : []),
        defaults[component],
      ];
    }
  } else if (forbidden.kind === "oversized-module") {
    locations = [`${defaults[component]}${"x".repeat(257)}`];
  } else if (forbidden.kind === "oversized-frames") {
    locations = Array.from({ length: 33 }, () => defaults[component]);
  }
  return `Error: ${detail}\n${locations.map((location, index) => ` at frame${index} (${location}:${index + 1}:1)`).join("\n")}`;
}

async function exerciseJavaScriptAdapterPrivacy({ corpus, reporting, sink }) {
  const issuer = createDesktopErrorReporterIssuer({ getReporting: () => reporting });
  const results = [];

  const rendererListeners = new Map();
  const rendererPending = [];
  const rendererReporter = issuer("renderer", 1);
  const rendererAdapter = installRendererErrorReporting({
    windowTarget: {
      addEventListener: (name, listener) => rendererListeners.set(name, listener),
      removeEventListener: (name) => rendererListeners.delete(name),
    },
    locationTarget: { origin: "http://127.0.0.1:43120" },
    send: (record) => {
      const pending = rendererReporter.report(record);
      rendererPending.push(pending);
      return pending;
    },
  });

  const processTarget = new EventEmitter();
  const mainPending = [];
  const mainAdapter = installElectronMainErrorAdapter({
    processTarget,
    processGeneration: 1,
    issueErrorReporter: (component, processGeneration) => {
      const reporter = issuer(component, processGeneration);
      return Object.freeze({
        report(record) {
          const pending = reporter.report(record);
          mainPending.push(pending);
          return pending;
        },
        revoke: () => reporter.revoke(),
      });
    },
  });

  try {
    for (const component of ["renderer", "electron-main", "node-harness-host"]) {
      for (const forbidden of corpus.forbiddenCases) {
        const before = sink.requests.length;
        const error = { name: "Error", stack: adapterStack(component, forbidden) };
        if (component === "renderer") {
          rendererListeners.get("error")({ error });
          await Promise.all(rendererPending.splice(0));
        } else {
          processTarget.emit("uncaughtExceptionMonitor", error, "uncaughtException");
          await Promise.all(mainPending.splice(0));
        }
        const requests = sink.requests.slice(before);
        invariant(requests.every((request) => !request.includes("privacy-sentinel")), `${component}/${forbidden.id} crossed a JavaScript adapter`);
        results.push({ component, fixture: forbidden.id, crossed: false });
      }
    }
  } finally {
    rendererAdapter.close();
    rendererReporter.revoke();
    mainAdapter.close();
  }
  sink.requests.splice(0);
  return results;
}

function parseEvent(requestBody) {
  const lines = requestBody.trim().split("\n");
  invariant(lines.length === 3, "Sentry request must contain one envelope item");
  const header = JSON.parse(lines[0]);
  const item = JSON.parse(lines[1]);
  const event = JSON.parse(lines[2]);
  invariant(item.type === "event", "Sentry envelope item must be an error event");
  invariant(JSON.stringify(Object.keys(event).sort()) === JSON.stringify([...APPROVED_EVENT_KEYS].sort()), "outbound event keys are not exact");
  invariant(header.event_id === event.event_id, "envelope and event identities differ");
  return event;
}

async function releaseProofStatus() {
  const sources = await Promise.all(releaseAuthorityPaths.map(async (path) => {
    const text = await readFile(join(repositoryRoot, path), "utf8");
    return { path, sha256: sha256(text), text };
  }));
  const combined = sources.map((source) => source.text).join("\n");
  const signals = Object.freeze({
    sourceMapProduction: /(?:identitySourceMap|source-maps|--sourcemap)/u.test(combined),
    rustSymbolProduction: /(?:\.dSYM|\.pdb|CARGO_PROFILE_RELEASE_DEBUG|debuginfo\s*=)/u.test(combined),
    sentryUploadCommand: /(?:sourcemaps|debug-files)[^\n]*upload/u.test(combined),
    sentryUploadCredential: /SENTRY_AUTH_TOKEN/u.test(combined),
  });
  const configured = Object.values(signals).every(Boolean);
  return Object.freeze({
    status: "not-run",
    context: "preview-or-stable-release-candidate-only",
    deterministicFinding: configured
      ? "release-upload-authority-present-but-not-executed"
      : "no-source-map-symbol-upload-authority-configured",
    inspected: sources.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
    signals,
    networkUsed: false,
  });
}

export async function runDeterministicTelemetryPortfolio({ execute } = {}) {
  const vitestPath = join(repositoryRoot, "node_modules/vitest/vitest.mjs");
  const vitestArgs = [vitestPath, "run", ...productionPortfolioFiles];
  const rustArgs = ["test", "-p", "relayer-telemetry-capability", "--test", "panic_capability"];
  const run = execute ?? ((command, commandArgs) => new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Telemetry production portfolio failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  }));
  await run("cargo", rustArgs);
  await run(process.execPath, vitestArgs);
  return Object.freeze({
    status: "pass",
    fidelity: "deterministic-adapters-and-shared-rust-seam",
    commands: Object.freeze([
      `cargo ${rustArgs.join(" ")}`,
      `vitest run ${productionPortfolioFiles.join(" ")}`,
    ]),
    files: productionPortfolioFiles,
    limitations: Object.freeze(["spawned-production-rust-panic-not-run"]),
  });
}

export async function runTelemetryEvidence({
  outputPath = defaultOutputPath,
  productionAdapters = Object.freeze({
    status: "not-run",
    context: "invoke-npm-run-evidence-telemetry-for-production-portfolio",
  }),
} = {}) {
  const corpusText = await readFile(corpusPath, "utf8");
  const corpus = JSON.parse(corpusText);
  invariant(corpus.schema === "relayer.telemetry-privacy-corpus/v1", "privacy corpus version is invalid");
  invariant(corpus.positiveCases.length === 5, "privacy corpus must cover five components");
  const directory = await mkdtemp(join(tmpdir(), "relayer-telemetry-evidence-"));
  const queuePath = join(directory, "queue.json");
  const sink = await createLoopbackSink();
  const sealer = createLocalSealer();
  const transport = createSentryErrorTransport({ dsn: sink.dsn, flushTimeoutMs: 1_000 });
  const reporting = await createDesktopAuthenticatedErrorReporting({
    queuePath,
    encrypt: sealer.encrypt,
    decrypt: sealer.decrypt,
    transport,
    releaseIdentity,
  });
  const positiveResults = [];
  const negativeResults = [];
  let adapterPrivacy = [];
  try {
    await reporting.account.transitionIdentity({ generation: 1, subject: "auth0|telemetry-evidence-subject" });
    adapterPrivacy = await exerciseJavaScriptAdapterPrivacy({ corpus, reporting, sink });
    for (const [index, fixture] of corpus.positiveCases.entries()) {
      const record = { code: fixture.code, exceptionClass: fixture.exceptionClass, frames: fixture.frames };
      const external = fixture.component !== "electron-main";
      const authority = external
        ? reporting.issueCapability({ component: fixture.component, processGeneration: index + 1 })
        : reporting.issueReporter({ component: fixture.component, processGeneration: index + 1 });
      invariant(authority !== null, `${fixture.component} authority was not issued`);
      const positive = external ? await submit(authority, record) : await authority.report(record);
      invariant(external ? positive.status === 202 && positive.body.accepted === true : positive.accepted === true, `${fixture.component} positive fixture was rejected`);
      positiveResults.push({ component: fixture.component, seam: external ? "authenticated-loopback-receiver" : "electron-main-reporter", accepted: true });

      for (const forbidden of corpus.forbiddenCases) {
        const result = external ? await submit(authority, mutate(record, forbidden)) : await authority.report(mutate(record, forbidden));
        const rejected = external ? result.status === 400 && result.body.accepted === false : result.accepted === false && result.reason === "invalid-record";
        invariant(rejected, `${fixture.component}/${forbidden.id} crossed the privacy boundary`);
        negativeResults.push({ component: fixture.component, fixture: forbidden.id, rejected: true });
      }
      authority.revoke();
    }

    invariant(sink.requests.length === 5, "privacy rejections created an outbound request");
    const outbound = sink.requests.map(parseEvent);
    invariant(new Set(outbound.map((event) => event.tags.component)).size === 5, "outbound envelopes do not cover five components");
    await reporting.close();
    await sink.close();
    let queuePersisted = true;
    try {
      await stat(queuePath);
    } catch (error) {
      if (error?.code === "ENOENT") queuePersisted = false;
      else throw error;
    }
    invariant(queuePersisted === false, "rejected privacy fixtures reached queue persistence");

    const artifact = {
      schema: "relayer.telemetry-evidence/v1",
      corpus: { schema: corpus.schema, sha256: sha256(corpusText) },
      execution: { inference: false, liveAuth0: false, liveSentry: false, network: "loopback-only" },
      checkpoints: {
        positive: positiveResults,
        privacy: negativeResults,
        adapterPrivacy,
        outbound: {
          requestCount: sink.requests.length,
          components: outbound.map((event) => event.tags.component).sort(),
          exactEventKeys: APPROVED_EVENT_KEYS,
          forbiddenQueuePersistence: false,
        },
        releaseSymbols: await releaseProofStatus(),
        productionAdapters,
      },
      verdict: "local-gateway-privacy-pass-release-indeterminate",
    };
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    invariant(!serialized.includes("privacy-sentinel"), "artifact contains forbidden fixture contents");
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
    return Object.freeze({ artifact, outputPath });
  } finally {
    await reporting.close().catch(() => undefined);
    await sink.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const productionAdapters = await runDeterministicTelemetryPortfolio();
  const result = await runTelemetryEvidence({ productionAdapters });
  console.log(JSON.stringify({ ok: true, evidence: result.outputPath }, null, 2));
}

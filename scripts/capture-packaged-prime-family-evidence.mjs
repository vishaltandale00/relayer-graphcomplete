import { extractFile, listPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  createDeterministicPrimeProviderServer,
  PRIME_EVIDENCE_API_KEY,
  PRIME_EVIDENCE_CHILD_MODEL,
  PRIME_EVIDENCE_ROOT_MODEL,
} from "./prime-evidence/deterministic-openai-server.mjs";
import { verifyPrimeContractMatrix } from "./prime-evidence/contract-matrix.mjs";

const run = promisify(execFile);
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const repositoryRoot = resolve(import.meta.dirname, "..");

function argument(name, { optional = false } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  if (!value && !optional) throw new Error(`Missing required --${name} argument.`);
  return value || null;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }
  close() { this.socket?.close(); }
}

async function connect(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = response.ok ? await response.json() : [];
      const target = targets.find(({ type, webSocketDebuggerUrl }) => type === "page" && webSocketDebuggerUrl);
      if (!target) throw new Error("renderer target is not ready");
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.open();
      await client.call("Runtime.enable");
      await client.call("Page.enable");
      return client;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`Timed out connecting to packaged Relayer: ${lastError?.message}`);
}

async function waitFor(client, label, expression, predicate = Boolean, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await client.evaluate(expression);
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}; last value=${JSON.stringify(value)}`);
}

async function click(client, selector) {
  return client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) throw new Error(${JSON.stringify(`Cannot click ${selector}`)});
    element.click();
    return true;
  })()`);
}

async function fill(client, selector, value) {
  return client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error(${JSON.stringify(`Missing ${selector}`)});
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value;
  })()`);
}

async function createCertificate(directory) {
  const key = join(directory, "provider.key.pem");
  const certificate = join(directory, "provider.cert.pem");
  const configuration = join(directory, "openssl.cnf");
  await writeFile(configuration, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relayer deterministic evidence\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n`);
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", configuration, "-keyout", key, "-out", certificate]);
  return { key, certificate, tls: { key: await readFile(key), cert: await readFile(certificate) } };
}

function packagedPaths(applicationPath) {
  const appPath = resolve(applicationPath);
  if (process.platform === "darwin") return {
    executable: join(appPath, "Contents", "MacOS", basename(appPath, ".app")),
    resources: join(appPath, "Contents", "Resources"),
  };
  return { executable: appPath, resources: join(dirname(appPath), "resources") };
}

function verifyPrimePackage(resources) {
  const asar = join(resources, "app.asar");
  const entries = new Set(listPackage(asar).map((entry) => String(entry).replace(/^\//, "")));
  const required = [
    "main/index.mjs",
    "main/providers/implementations/openai-api.mjs",
    "node_modules/@relayer/harness-host/dist/implementations/prime-agent.js",
  ];
  for (const entry of required) if (!entries.has(entry)) throw new Error(`Packaged Prime evidence requires ${entry} in app.asar (#173).`);
  const primePackage = [...entries].find((entry) => /node_modules\/(?:@earendil-works\/pi-coding-agent|prime-agent)\/package\.json$/.test(entry));
  if (!primePackage) throw new Error("Packaged Prime evidence requires the Prime runtime in app.asar (#173).");
  const harnessPath = join(resources, "harnesses", "prime-agent-basic.yaml");
	const primeManifestPath = join(resources, "prime-agent", "manifest.json");
  const metadata = JSON.parse(extractFile(asar, "package.json").toString("utf8"));
	return { asar, entries, primePackage, harnessPath, primeManifestPath, metadata };
}

async function capture(client, directory, name, frames, hold = 8) {
  const result = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
  const bytes = Buffer.from(result.data, "base64");
  const path = join(directory, "screenshots", `${name}.png`);
  await writeFile(path, bytes, { mode: 0o600 });
  for (let index = 0; index < hold; index += 1) frames.push({ name, bytes });
  return { name, path, bytes: bytes.length, sha256: sha256(bytes) };
}

async function encodeVideo(outputDirectory, frames, ffmpeg, ffprobe) {
  const frameDirectory = join(outputDirectory, "frames");
  await mkdir(frameDirectory, { recursive: true });
  await Promise.all(frames.map(({ bytes }, index) => writeFile(join(frameDirectory, `${String(index + 1).padStart(5, "0")}.png`), bytes)));
  const path = join(outputDirectory, "prime-family-packaged.mp4");
  await run(ffmpeg, ["-y", "-framerate", "8", "-i", join(frameDirectory, "%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
  const probe = JSON.parse((await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,width,height,duration,nb_frames", "-of", "json", path])).stdout).streams?.[0];
  if (probe?.codec_name !== "h264" || probe?.pix_fmt !== "yuv420p") throw new Error(`Invalid evidence video: ${JSON.stringify(probe)}`);
  const bytes = await readFile(path);
  const playbackDirectory = join(outputDirectory, "playback");
  await mkdir(playbackDirectory, { recursive: true });
  const duration = Number(probe.duration);
  const playback = [];
  for (const [name, timestamp] of [["first", 0], ["middle", duration / 2], ["last", Math.max(0, duration - 0.15)]]) {
    const framePath = join(playbackDirectory, `${name}.png`);
    await run(ffmpeg, ["-y", "-ss", String(timestamp), "-i", path, "-frames:v", "1", framePath]);
    const frameBytes = await readFile(framePath);
    playback.push({ name, path: framePath, bytes: frameBytes.length, sha256: sha256(frameBytes) });
  }
  if (new Set(playback.map(({ sha256: digest }) => digest)).size !== playback.length) {
    throw new Error("Decoded first, middle, and last playback frames must be visibly distinct.");
  }
  const posterPath = join(outputDirectory, "prime-family-packaged-poster.png");
  await copyFile(playback.at(-1).path, posterPath);
  const posterBytes = await readFile(posterPath);
  return {
    path, bytes: bytes.length, sha256: sha256(bytes), probe, playback,
    poster: { path: posterPath, bytes: posterBytes.length, sha256: sha256(posterBytes) },
  };
}

async function launch({ executable, profile, port, certificate }) {
  const logs = [];
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      RELAYER_DESKTOP_USER_DATA_DIR: profile,
      NODE_EXTRA_CA_CERTS: certificate,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  child.on("error", (error) => logs.push(error.stack));
  try {
    const client = await Promise.race([
      connect(port),
      new Promise((_resolve, reject) => child.once("exit", (code, signal) => {
        reject(new Error(`Packaged Relayer exited before DevTools was ready (${code ?? signal ?? "unknown"}).`));
      })),
    ]);
    return { child, logs, client };
  } catch (error) {
    if (child.exitCode == null) child.kill("SIGTERM");
    const diagnostic = logs.join("").slice(-8_000);
    throw new Error(`${error.message}${diagnostic ? `\n${diagnostic}` : ""}`);
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!address || typeof address === "string") throw new Error("Could not reserve a local DevTools port.");
  return address.port;
}

async function stop(instance) {
  instance.client.close();
  instance.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => instance.child.once("exit", resolveExit)),
    delay(10_000).then(() => { instance.child.kill("SIGKILL"); }),
  ]);
}

async function readModelSettings(client) {
  return client.evaluate("fetch('/api/model-settings').then((response) => response.json())");
}

async function runEvidence() {
  const application = argument("app");
  const outputDirectory = resolve(argument("output"));
  const ffmpeg = argument("ffmpeg", { optional: true }) || "ffmpeg";
  const ffprobe = argument("ffprobe", { optional: true }) || "ffprobe";
	const primeSourceRoot = resolve(argument("prime-source"));
  const keepProfile = process.argv.includes("--keep-profile");
  const { executable, resources } = packagedPaths(application);
  const packaged = verifyPrimePackage(resources);
	const primeManifest = JSON.parse(await readFile(packaged.primeManifestPath, "utf8"));
  const relayerSourceCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
  const relayerSourceStatus = (await run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repositoryRoot })).stdout.trim();
  if (relayerSourceStatus) throw new Error("Relayer source worktree must be clean before evidence capture.");
  if (packaged.metadata.relayerReleaseSourceCommit !== relayerSourceCommit) {
    throw new Error("Packaged Relayer source commit does not match the clean evidence checkout.");
  }
  const scratch = await mkdtemp(join(tmpdir(), "relayer-prime-packaged-"));
  const profile = join(scratch, "profile");
  await mkdir(join(outputDirectory, "screenshots"), { recursive: true });
  const certificate = await createCertificate(scratch);
  const provider = await createDeterministicPrimeProviderServer({ tls: certificate.tls });
  const screenshots = [];
  const frames = [];
  const assertions = [];
  const priorProcessLogs = [];
  let instance;
  let providerId;
  try {
		const contractMatrix = await verifyPrimeContractMatrix({
			repositoryRoot,
			outputDirectory,
			primeSourceRoot,
			expectedPrimeCommit: primeManifest.source.commit,
		});
    instance = await launch({ executable, profile, port: await availablePort(), certificate: certificate.certificate });
    const client = instance.client;
    await waitFor(client, "provider onboarding", "Boolean(document.querySelector('[data-provider-adapter=\"openai-api\"]'))");
    await capture(client, outputDirectory, "01-clean-profile-incompatible-default", frames).then((item) => screenshots.push(item));
    await click(client, '[data-provider-adapter="openai-api"]');
    await fill(client, "#providerField-label", "Deterministic OpenAI connection");
    await fill(client, "#providerField-endpoint", provider.endpoint);
    await fill(client, '[data-provider-field="api-key"]', PRIME_EVIDENCE_API_KEY);
    await click(client, "#connectProvider");
    await waitFor(client, "Prime onboarding choice", "Boolean(document.querySelector('[data-onboarding-harness=\"prime-agent-basic\"]:not(:disabled)'))");
    const incompatibleCopy = await client.evaluate("document.querySelector('#providerFamilyStep')?.innerText || ''");
    if (!/Codex/i.test(incompatibleCopy) || !/Prime/i.test(incompatibleCopy)) throw new Error("Onboarding did not expose incompatible default and Prime choice.");
    assertions.push("clean profile exposes incompatible app default and an explicit Prime choice");
    await capture(client, outputDirectory, "02-explicit-prime-choice", frames).then((item) => screenshots.push(item));
    await click(client, '[data-onboarding-harness="prime-agent-basic"]');
    await waitFor(client, "custom family choice", "Boolean(document.querySelector('[data-onboarding-family-kind=\"create\"]'))");
    await click(client, '[data-onboarding-family-kind="create"]');
    await fill(client, "#onboardingFamilyName", "Prime Evidence Family");
    for (const model of [PRIME_EVIDENCE_ROOT_MODEL, PRIME_EVIDENCE_CHILD_MODEL]) {
      await click(client, `[data-onboarding-member-model="${model}"]`);
    }
    await capture(client, outputDirectory, "03-family-members-selected", frames).then((item) => screenshots.push(item));
    await click(client, "#finishProviderSetup");
    await waitFor(client, "application composer", "!document.querySelector('#appShell')?.classList.contains('hidden')");
    const settings = await readModelSettings(client);
    const family = settings.families.find(({ name }) => name === "Prime Evidence Family");
    if (!family || settings.defaults.harnessId !== "prime-agent-basic") throw new Error("Prime family was not made the default through onboarding.");
    providerId = family.members.find(({ modelId }) => modelId === PRIME_EVIDENCE_CHILD_MODEL)?.providerId;
    if (!providerId) throw new Error("Connected provider ID is absent from the custom family.");
    provider.setChildSelector(`relayer-openai-api-${Buffer.from(providerId).toString("base64url")}/${PRIME_EVIDENCE_CHILD_MODEL}`);
    await click(client, "#newModelControl [data-model-picker-trigger]");
    await writeFile(join(outputDirectory, "debug-picker.json"), `${JSON.stringify(await client.evaluate(`({
      label: document.querySelector('#newModelControl [data-model-picker-label]')?.textContent,
      popoverHidden: document.querySelector('#newModelControl [data-model-picker-popover]')?.classList.contains('hidden'),
      options: [...document.querySelectorAll('#newModelControl [data-model-option]')].map(({ dataset }) => ({ ...dataset })),
    })`), null, 2)}\n`);
    await waitFor(client, "root model option", `Boolean(document.querySelector('#newModelControl [data-model-option][data-model-id="${PRIME_EVIDENCE_ROOT_MODEL}"]'))`);
    await click(client, `#newModelControl [data-model-option][data-model-id="${PRIME_EVIDENCE_ROOT_MODEL}"]`);
    await fill(client, "#newThreadPrompt", "Use the exact selected root and its second family member recursively, then submit the evidence graph.");
    await capture(client, outputDirectory, "04-explicit-root-selection", frames).then((item) => screenshots.push(item));
    await click(client, "#createThread");
    await waitFor(client, "recursive child provider request", "true", () => provider.observations.some(({ pathname, recursionRole }) => (
      pathname === "/v1/responses" && recursionRole === "child"
    )), 120_000);
    await waitFor(client, "accepted graph", `(() => (
      document.querySelectorAll('[data-node]').length >= 2
      && document.querySelector('#interactionStatus')?.classList.contains('hidden')
      && document.querySelector('#threadPrompt')?.disabled === false
    ))()`, Boolean, 120_000);
    await capture(client, outputDirectory, "05-root-child-accepted-graph", frames).then((item) => screenshots.push(item));
    const firstRequests = provider.observations.filter(({ pathname }) => pathname === "/v1/responses");
    if (!firstRequests.some(({ recursionRole, model }) => recursionRole === "root" && model === PRIME_EVIDENCE_ROOT_MODEL)) throw new Error("Exact selected root did not execute.");
    if (!firstRequests.some(({ recursionRole, model }) => recursionRole === "child" && model === PRIME_EVIDENCE_CHILD_MODEL)) throw new Error("Second family member did not execute recursively.");
    assertions.push("exact selected root executes; Prime native recursion uses the second family member; graph is accepted");
    const sessionId = firstRequests.find(({ recursionRole }) => recursionRole === "root")?.sessionId;
    await click(client, '#threadComposer [data-model-picker-trigger]');
    await waitFor(client, "follow-up model option", `Boolean(document.querySelector('#threadComposer [data-model-option][data-model-id="${PRIME_EVIDENCE_CHILD_MODEL}"]'))`);
    await click(client, `#threadComposer [data-model-option][data-model-id="${PRIME_EVIDENCE_CHILD_MODEL}"]`);
    await fill(client, "#threadPrompt", "Follow-up: change the selected orchestrator and continue the same Prime session.");
    const priorTurnCount = Number((await client.evaluate("document.querySelector('#turnPickerButton')?.textContent || ''")).match(/of (\d+)/)?.[1] || 0);
    await click(client, "#sendInteraction");
    await waitFor(client, "follow-up provider request", "true", () => provider.observations.filter(({ pathname, model }) => pathname === "/v1/responses" && model === PRIME_EVIDENCE_CHILD_MODEL).length >= 2, 120_000);
    await waitFor(client, "accepted follow-up turn", `(() => {
      const count = Number((document.querySelector('#turnPickerButton')?.textContent || '').match(/of (\\d+)/)?.[1] || 0);
      return count > ${priorTurnCount}
        && document.querySelector('#threadPrompt')?.value === ''
        && document.querySelector('#threadPrompt')?.disabled === false
        && document.querySelector('#interactionStatus')?.classList.contains('hidden')
        && document.querySelectorAll('[data-node]').length >= 2;
    })()`, Boolean, 120_000);
    const acceptedFollowup = await client.evaluate(`({
      interactionId: new URL(location.href).searchParams.get('interactionId'),
      turnLabel: document.querySelector('#turnPickerButton')?.textContent || '',
      modelLabel: document.querySelector('#threadComposer [data-model-picker-label]')?.textContent || '',
    })`);
    if (!acceptedFollowup.interactionId || !acceptedFollowup.modelLabel) {
      throw new Error("Accepted follow-up identity or selected model is unavailable.");
    }
    const followup = provider.observations.filter(({ pathname }) => pathname === "/v1/responses").at(-1);
    if (followup.model !== PRIME_EVIDENCE_CHILD_MODEL || followup.sessionId !== sessionId) throw new Error("Follow-up did not change root inside the same Prime session.");
    assertions.push("follow-up changes orchestrator while retaining the Prime session");
    await capture(client, outputDirectory, "06-follow-up-new-root-same-session", frames).then((item) => screenshots.push(item));
    await stop(instance);
    priorProcessLogs.push(...instance.logs);
    instance = await launch({ executable, profile, port: await availablePort(), certificate: certificate.certificate });
    await waitFor(instance.client, "resumed thread", "Boolean(document.querySelector('#chatList .entry'))");
    await click(instance.client, "#chatList .entry");
    await waitFor(instance.client, "resumed accepted follow-up", `(() => (
      new URL(location.href).searchParams.get('interactionId') === ${JSON.stringify(acceptedFollowup.interactionId)}
      && document.querySelector('#turnPickerButton')?.textContent === ${JSON.stringify(acceptedFollowup.turnLabel)}
      && document.querySelector('#threadComposer [data-model-picker-label]')?.textContent === ${JSON.stringify(acceptedFollowup.modelLabel)}
      && document.querySelector('#interactionStatus')?.classList.contains('hidden')
      && document.querySelectorAll('[data-node]').length >= 2
    ))()`, Boolean, 60_000);
    const resumedSettings = await readModelSettings(instance.client);
    if (resumedSettings.defaults.harnessId !== "prime-agent-basic" || String(resumedSettings.defaults.familyId) !== String(family.id)) {
      throw new Error("Restart did not preserve the saved Prime harness and family defaults.");
    }
    assertions.push("clean process restart resumes persisted thread and accepted graph");
    await capture(instance.client, outputDirectory, "07-restart-resume", frames).then((item) => screenshots.push(item));
    await click(instance.client, "#newThread");
    await waitFor(instance.client, "new composer after restart", "Boolean(document.querySelector('#newThreadPrompt'))");
    await click(instance.client, "#permissionButton");
    await click(instance.client, '[data-permission-profile="ask"]');
    await click(instance.client, "#newModelControl [data-model-picker-trigger]");
    await waitFor(instance.client, "Ask root model option", `Boolean(document.querySelector('#newModelControl [data-model-option][data-model-id="${PRIME_EVIDENCE_ROOT_MODEL}"]'))`);
    await click(instance.client, `#newModelControl [data-model-option][data-model-id="${PRIME_EVIDENCE_ROOT_MODEL}"]`);
    await fill(instance.client, "#newThreadPrompt", "Ask boundary: request a graph write, accept a denial, then request it again.");
    await click(instance.client, "#createThread");
    await waitFor(instance.client, "Ask approval", "!document.querySelector('#approvalDock')?.classList.contains('hidden')", Boolean, 120_000);
    await capture(instance.client, outputDirectory, "08-ask-boundary", frames).then((item) => screenshots.push(item));
    await click(instance.client, "#denyApproval");
    await waitFor(instance.client, "second approval after denial", "document.querySelector('#approvalHistoryList')?.textContent.includes('Denied') && !document.querySelector('#approvalDock')?.classList.contains('hidden') && document.querySelector('#approvalEyebrow')?.textContent === 'Needs approval'", Boolean, 120_000);
    await instance.client.evaluate("document.querySelector('#approvalHistory').open = true");
    await capture(instance.client, outputDirectory, "09-denial-receipt-and-new-boundary", frames).then((item) => screenshots.push(item));
    await click(instance.client, "#approveOnce");
    await waitFor(instance.client, "Ask graph acceptance", `(() => (
      document.querySelectorAll('[data-node]').length >= 2
      && document.querySelector('#interactionStatus')?.classList.contains('hidden')
      && document.querySelector('#threadPrompt')?.disabled === false
    ))()`, Boolean, 120_000);
    assertions.push("Auto accepts the initial graph; Ask stops at the write boundary and preserves denial evidence before a new explicit approval");
    await fill(instance.client, "#threadPrompt", "This draft must remain when its provider catalog is revoked.");
    provider.setModels([{ id: "relayer-evidence-replacement", name: "Evidence Replacement" }]);
    await instance.client.evaluate(`window.relayerDesktop.models.refresh(${JSON.stringify(providerId)})`);
    await click(instance.client, "#settingsButton");
    await waitFor(instance.client, "refreshed model settings", "!document.querySelector('#settingsView')?.classList.contains('hidden') && document.querySelector('#familyCarousel')?.textContent.includes('The provider no longer reports this model.')", Boolean, 60_000);
    await click(instance.client, "#settingsBackButton");
    await click(instance.client, "#chatList [data-thread].active");
    await waitFor(instance.client, "revoked draft block", `(() => ({ value: document.querySelector('#threadPrompt')?.value, disabled: document.querySelector('#sendInteraction')?.disabled, title: document.querySelector('#sendInteraction')?.title }))()`, (value) => value?.disabled && /draft must remain/.test(value.value), 60_000);
    assertions.push("lazy catalog invalidation blocks the preserved stale draft without silently choosing a replacement");
    await capture(instance.client, outputDirectory, "10-revoked-draft-blocked", frames).then((item) => screenshots.push(item));

    const video = await encodeVideo(outputDirectory, frames, ffmpeg, ffprobe);
    const asarBytes = await readFile(packaged.asar);
    const logPath = join(outputDirectory, "packaged-app.log");
    const logBytes = Buffer.from([...priorProcessLogs, ...instance.logs].join(""));
    const manifest = {
      schemaVersion: 1,
      issue: 174,
      generatedAt: new Date().toISOString(),
      productionComposition: {
        app: resolve(application),
        executable,
        asar: { path: packaged.asar, bytes: asarBytes.length, sha256: sha256(asarBytes) },
        packageVersion: packaged.metadata.version,
        releaseSourceCommit: relayerSourceCommit,
        primeRuntimeEntry: packaged.primePackage,
				primeSourceCommit: primeManifest.source.commit,
        primeHarnessPath: packaged.harnessPath,
        providerAdapter: "openai-api",
        providerTransport: "local deterministic OpenAI-compatible HTTPS",
        fixtureHarnessOrAdapterInjected: false,
        releaseConfigurationOverrideEnabled: false,
      },
      selection: { harnessId: "prime-agent-basic", familyId: family.id, familyRevision: family.revision, providerId, initialRoot: PRIME_EVIDENCE_ROOT_MODEL, recursiveChild: PRIME_EVIDENCE_CHILD_MODEL, followupRoot: PRIME_EVIDENCE_CHILD_MODEL },
      session: { initialSessionId: sessionId, followupSessionId: followup.sessionId, sameSession: sessionId === followup.sessionId },
      deterministicContracts: contractMatrix,
      requests: provider.observations,
      assertions,
      screenshots,
      video,
      logs: { path: logPath, bytes: logBytes.length, sha256: sha256(logBytes) },
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (serialized.includes(PRIME_EVIDENCE_API_KEY)) throw new Error("Evidence manifest leaked the provider credential.");
    await writeFile(manifest.logs.path, logBytes, { mode: 0o600 });
    await writeFile(join(outputDirectory, "manifest.json"), serialized, { mode: 0o600 });
    process.stdout.write(`${join(outputDirectory, "manifest.json")}\n`);
  } catch (error) {
    const renderer = instance?.client
      ? await instance.client.evaluate(`(async () => ({
          approvalDockClass: document.querySelector('#approvalDock')?.className || null,
          approvalEyebrow: document.querySelector('#approvalEyebrow')?.textContent || null,
          approvalHistory: document.querySelector('#approvalHistoryList')?.textContent || null,
          approvalError: document.querySelector('#approvalError')?.textContent || null,
          interactionStatus: document.querySelector('#interactionStatus')?.textContent || null,
          settingsViewClass: document.querySelector('#settingsView')?.className || null,
          familyCarousel: document.querySelector('#familyCarousel')?.textContent || null,
          modelSettings: await fetch('/api/model-settings').then((response) => response.json()).catch(() => null),
        }))()`).catch(() => null)
      : null;
    await writeFile(join(outputDirectory, "failure-observations.json"), `${JSON.stringify({
      error: error.message,
      renderer,
      requests: provider.observations,
    }, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    if (instance?.child.exitCode == null) await stop(instance).catch(() => {});
    await provider.close().catch(() => {});
    if (!keepProfile) await rm(scratch, { recursive: true, force: true });
  }
}

runEvidence().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

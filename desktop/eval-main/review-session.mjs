import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COMMAND_CHANNEL = "relayer-eval:review-command";

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function presentationKey(state) {
  return canonicalJson({
    executionId: state.executionId,
    threadId: state.threadId,
    turnId: state.turnId,
    layerId: state.layerId,
    selectedNodeId: state.selectedNodeId,
    activatedActionId: state.activatedActionId,
    navigationPath: state.navigationPath,
  });
}

function validateState(executionId, state) {
  if (!state || state.executionId !== executionId) {
    throw new Error("The production workspace returned state for another evaluation execution.");
  }
  if (!state.threadId || !state.turnId) {
    throw new Error("The production review workspace has no selected thread and turn.");
  }
  if (!Array.isArray(state.navigationPath) || state.navigationPath.some((entry) => (
    !entry?.layerId || !(entry.viaActionId === null || typeof entry.viaActionId === "string")
  ))) throw new Error("The production review workspace returned an invalid navigation path.");
  const hasLayer = state.layerId !== null && state.layerId !== undefined;
  if (
    (!hasLayer && (state.navigationPath.length > 0 || state.selectedNodeId != null))
    || (hasLayer && (
      state.navigationPath.length === 0
      || String(state.navigationPath.at(-1)?.layerId) !== String(state.layerId)
    ))
  ) throw new Error("The production review workspace returned inconsistent layer state.");
  if (!state.viewport || !Number.isFinite(state.viewport.width) || !Number.isFinite(state.viewport.height)) {
    throw new Error("The production review workspace returned an invalid viewport.");
  }
  return {
    ...state,
    executionId: String(state.executionId),
    threadId: String(state.threadId),
    turnId: String(state.turnId),
    layerId: hasLayer ? String(state.layerId) : null,
    selectedNodeId: state.selectedNodeId === null || state.selectedNodeId === undefined
      ? null
      : String(state.selectedNodeId),
    activatedActionId: state.activatedActionId === null || state.activatedActionId === undefined
      ? null
      : String(state.activatedActionId),
    navigationPath: state.navigationPath.map((entry) => ({
      layerId: String(entry.layerId),
      viaActionId: entry.viaActionId === null ? null : String(entry.viaActionId),
    })),
    controls: (state.controls || []).map((control) => ({
      ...control,
      actionId: control.actionId === null || control.actionId === undefined ? null : String(control.actionId),
    })),
  };
}

function validateScreenshotInput({ target, mode, label }) {
  const validTarget = target?.kind === "viewport"
    || (target?.kind === "element" && typeof target.elementRef === "string" && target.elementRef);
  if (!validTarget) throw new Error("Screenshot target must identify the viewport or one visible element.");
  if (mode !== "visible" && mode !== "full") throw new Error("Screenshot mode must be visible or full.");
  if (target.kind === "viewport" && mode === "full") throw new Error("Full capture requires an element target.");
  if (typeof label !== "string" || !label.trim() || label.length > 120) {
    throw new Error("Screenshot label must contain 1 to 120 characters.");
  }
}

function reviewUiState(state) {
  return {
    turnId: state.turnId,
    layerId: state.layerId,
    selectedNodeId: state.selectedNodeId,
    activatedActionId: state.activatedActionId,
    navigationPath: structuredClone(state.navigationPath),
  };
}

export class ReviewSession {
  constructor({
    executionId,
    readOnly,
    webContents,
    artifactDirectory,
    ipc,
    commandTimeoutMs = 5_000,
  }) {
    if (!executionId) throw new Error("ReviewSession requires an execution ID.");
    if (readOnly !== true) throw new Error("ReviewSession requires server-enforced read-only authority.");
    if (!webContents?.send || !webContents?.capturePage || !webContents?.getURL) {
      throw new Error("ReviewSession requires Electron WebContents.");
    }
    if (!artifactDirectory) throw new Error("ReviewSession requires a local artifact directory.");
    if (!ipc?.on || !ipc?.removeListener) throw new Error("ReviewSession requires Electron ipcMain.");
    this.executionId = executionId;
    this.webContents = webContents;
    this.artifactDirectory = artifactDirectory;
    this.ipc = ipc;
    this.commandTimeoutMs = commandTimeoutMs;
    this.opened = false;
    this.interactionTrace = [];
    this.artifacts = new Map();
  }

  async open() {
    const location = new URL(this.webContents.getURL());
    if (
      location.protocol !== "http:"
      || location.hostname !== "127.0.0.1"
      || location.searchParams.get("review") !== "1"
    ) {
      throw new Error("ReviewSession requires the local production review workspace.");
    }
    const state = validateState(this.executionId, await this.#rendererCommand("snapshot"));
    this.opened = true;
    this.interactionTrace.push({ type: "session-opened", at: new Date().toISOString(), state: structuredClone(state) });
    return structuredClone(state);
  }

  async screenshot({ target, mode = "visible", label }) {
    validateScreenshotInput({ target, mode, label });
    this.#assertOpen();
    const initialState = validateState(this.executionId, await this.#rendererCommand("snapshot"));
    let plan;
    let state;
    let ownsCapture = false;
    const tileArtifacts = [];
    try {
      plan = await this.#rendererCommand("capturePlan", { target, mode });
      ownsCapture = target.kind === "element";
      state = validateState(this.executionId, await this.#rendererCommand("snapshot"));
      if (presentationKey(state) !== presentationKey(initialState)) {
        throw new Error("The production workspace changed presentation while preparing the screenshot.");
      }
      if (!Array.isArray(plan?.tiles) || !plan.tiles.length) throw new Error("The review capture plan has no tiles.");
      for (const tile of plan.tiles) {
        const prepared = target.kind === "viewport"
          ? { index: tile.index, clip: plan.clip }
          : await this.#rendererCommand("prepareCaptureTile", tile);
        const image = await this.webContents.capturePage(prepared.clip);
        const bytes = image.toPNG();
        if (!bytes.length) throw new Error(`Review screenshot tile ${tile.index} is empty.`);
        const size = image.getSize();
        tileArtifacts.push({
          index: tile.index,
          row: tile.row,
          column: tile.column,
          scrollX: tile.scrollX,
          scrollY: tile.scrollY,
          clip: prepared.clip,
          bytes,
          width: size.width,
          height: size.height,
          contentDigest: sha256(bytes),
        });
      }
    } finally {
      if (ownsCapture) await this.#rendererCommand("restoreCapture");
    }

    const screenshotId = `shot-${randomUUID()}`;
    const metadata = {
      schemaVersion: 1,
      screenshotId,
      label: label.trim(),
      executionId: this.executionId,
      threadId: state.threadId,
      turnId: state.turnId,
      layerId: state.layerId,
      selectedNodeId: state.selectedNodeId,
      activatedActionId: state.activatedActionId,
      navigationPath: [...state.navigationPath],
      viewport: structuredClone(state.viewport),
      captureTarget: structuredClone(target),
      mode,
      tileCount: tileArtifacts.length,
      tiles: tileArtifacts.map((tile) => ({
        index: tile.index,
        width: tile.width,
        height: tile.height,
        contentDigest: tile.contentDigest,
      })),
    };
    metadata.contentDigest = sha256(canonicalJson({
      state: metadata,
      tileDigests: metadata.tiles.map((tile) => tile.contentDigest),
    }));
    const directory = join(this.artifactDirectory, screenshotId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all(tileArtifacts.map((tile) => writeFile(
      join(directory, `${screenshotId}-${String(tile.index + 1).padStart(3, "0")}.png`),
      tile.bytes,
      { mode: 0o600 },
    )));
    await writeFile(join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    this.artifacts.set(screenshotId, directory);
    this.interactionTrace.push({
      type: "screenshot",
      at: new Date().toISOString(),
      screenshotId,
      contentDigest: metadata.contentDigest,
    });
    return {
      ok: true,
      screenshot: structuredClone(metadata),
      elements: (state.controls || []).map(({ elementRef, role, name, disabled }) => ({
        elementRef,
        role,
        name,
        disabled,
      })),
    };
  }

  async interact({ elementRef, activate }) {
    this.#assertOpen();
    if (typeof elementRef !== "string" || !elementRef) throw new Error("Interact requires an element reference.");
    if (activate !== true) throw new Error("The review interact tool supports activate only.");
    const before = validateState(this.executionId, await this.#rendererCommand("snapshot"));
    const control = before.controls?.find((candidate) => candidate.elementRef === elementRef);
    if (!control) throw new Error(`Unknown or invisible review control: ${elementRef}`);
    if (control.kind === "capture-region") throw new Error(`Review element is a screenshot target, not an interactive control: ${elementRef}`);
    if (control.disabled) throw new Error(`Review control is disabled: ${elementRef}`);
    await this.#rendererCommand("activate", { elementRef, operation: "activate" });
    const after = await this.#waitForInteractionState(before, control);
    this.interactionTrace.push({
      type: "interact",
      at: new Date().toISOString(),
      elementRef,
      operation: "activate",
      control: { name: control.name, role: control.role, kind: control.kind, actionId: control.actionId },
      state: structuredClone(after),
    });
    return { ok: true, state: reviewUiState(after) };
  }

  async history({ delta }) {
    this.#assertOpen();
    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw new Error("History delta must be a non-zero signed integer.");
    }
    const restored = validateState(
      this.executionId,
      await this.#rendererCommand("history", { delta }),
    );
    const observed = validateState(this.executionId, await this.#rendererCommand("snapshot"));
    if (presentationKey(observed) !== presentationKey(restored)) {
      throw new Error("The production workspace did not restore the requested review history state.");
    }
    this.interactionTrace.push({
      type: "history",
      at: new Date().toISOString(),
      delta,
      state: structuredClone(observed),
    });
    return { ok: true, state: reviewUiState(observed) };
  }

  trace() {
    return structuredClone(this.interactionTrace);
  }

  artifactDirectoryFor(screenshotId) {
    return this.artifacts.get(screenshotId) || null;
  }

  async #waitForInteractionState(before, control) {
    const deadline = Date.now() + this.commandTimeoutMs;
    let current = validateState(this.executionId, await this.#rendererCommand("snapshot"));
    const changedAsExpected = (state) => {
      if (control.kind === "node") return state.selectedNodeId !== before.selectedNodeId;
      if (control.kind === "navigate-action") return presentationKey(state) !== presentationKey(before);
      if (control.kind === "turn") return state.turnId !== before.turnId;
      if (control.kind === "thread") return state.threadId !== before.threadId;
      if (control.kind === "history") return presentationKey(state) !== presentationKey(before);
      return true;
    };
    while (!changedAsExpected(current) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = validateState(this.executionId, await this.#rendererCommand("snapshot"));
    }
    if (!changedAsExpected(current)) {
      throw new Error(`Review control did not change the expected presentation: ${control.elementRef}`);
    }
    return current;
  }

  #assertOpen() {
    if (!this.opened) throw new Error("ReviewSession must be opened before using tools.");
    if (this.webContents.isDestroyed?.()) throw new Error("The production review window is closed.");
  }

  #rendererCommand(command, payload) {
    if (this.webContents.isDestroyed?.()) return Promise.reject(new Error("The production review window is closed."));
    const responseChannel = `relayer-eval:review-response:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.ipc.removeListener(responseChannel, onResponse);
      };
      const onResponse = (event, response) => {
        if (event.sender !== this.webContents) return;
        cleanup();
        if (response?.error) reject(new Error(response.error));
        else resolve(response?.result);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Production review command timed out: ${command}`));
      }, this.commandTimeoutMs);
      this.ipc.on(responseChannel, onResponse);
      this.webContents.send(COMMAND_CHANNEL, { responseChannel, command, payload });
    });
  }
}

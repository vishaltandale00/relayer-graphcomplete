import { APPEARANCE_PREFERENCES, resolvedAppearance, windowBackgroundColor } from "../appearance.mjs";
import { inspectFolder } from "../services/folder-service.mjs";
import { isTerminalConnectionFailure } from "../providers/provider-definition-service.mjs";

// Sign-in continues in the browser, so the browser has to come forward.
// Relying on the platform default left users looking at an unchanged
// Relayer window while the real next step sat behind it.
const BROWSER_HANDOFF = Object.freeze({ activate: true });

// connect() and reconnect() create the pending attempt before the browser is
// handed the URL. If that handoff fails, nothing downstream ever sees the
// attempt, so it would keep owning the provider name and reject the retry.
async function handOffToBrowser(shell, providerDefinitions, result) {
  if (!result.login?.authUrl) return;
  try {
    await shell.openExternal(result.login.authUrl, BROWSER_HANDOFF);
  } catch (error) {
    const connectionId = result.connectionId ?? result.providerDefinition?.id;
    if (connectionId) {
      await Promise.resolve(providerDefinitions.cancelConnection(connectionId)).catch(() => undefined);
    }
    throw error;
  }
}

// A pending attempt owns the provider name, but the poll that settles it and
// the ownership that cancels it live only in renderer memory. macOS keeps main
// running after the last window closes, and `activate` builds a new window with
// new contents that cannot discover the attempt, so a closed window would hold
// the name until the app restarts. Bind the attempt to the contents that began
// it and cancel it when they go.
function bindConnectionToRenderer(providerDefinitions, contents, connectionId, onFired) {
  if (typeof contents?.once !== "function") return () => {};
  const cancel = () => {
    onFired();
    void Promise.resolve(providerDefinitions.cancelConnection(connectionId)).catch(() => undefined);
  };
  contents.once("destroyed", cancel);
  return () => contents.removeListener?.("destroyed", cancel);
}

const MAX_COMPOSER_DRAFT_BYTES = 1024 * 1024;
const MAX_FOLLOWUP_DRAFTS = 256;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeComposerDrafts(value) {
  const pending = value?.pendingNewThread;
  const followups = value?.threadFollowups;
  const normalized = {
    pendingNewThread: pending && typeof pending.text === "string"
      ? { text: pending.text, scope: pending.scope ?? null }
      : null,
    threadFollowups: followups && typeof followups === "object" && !Array.isArray(followups)
      ? Object.fromEntries(Object.entries(followups).filter(([, text]) => typeof text === "string"))
      : {},
    // The retry restoration each draft grew from, and per thread a send whose
    // turn has not loaded (renderer composer-drafts.js).
    threadFollowupRestorations: plainObject(value?.threadFollowupRestorations)
      ? Object.fromEntries(Object.entries(value.threadFollowupRestorations)
        .filter(([, restorationId]) => typeof restorationId === "string"))
      : {},
    sentThreadFollowups: plainObject(value?.sentThreadFollowups)
      ? Object.fromEntries(Object.entries(value.sentThreadFollowups)
        .filter(([, record]) => typeof record?.scopeKey === "string"
          && typeof record.originScopeKey === "string" && typeof record.textDigest === "string"
          && typeof record.edited === "boolean" && Number.isSafeInteger(record.sends) && record.sends >= 1)
        .map(([threadId, record]) => [threadId, {
          scopeKey: record.scopeKey,
          originScopeKey: record.originScopeKey,
          textDigest: record.textDigest,
          edited: record.edited,
          sends: record.sends,
        }]))
      : {},
  };
  const followupKeys = Object.keys(normalized.threadFollowups);
  for (const staleKey of followupKeys.slice(0, -MAX_FOLLOWUP_DRAFTS)) {
    delete normalized.threadFollowups[staleKey];
  }
  // Over the cap, records that protect no draft go first, oldest first.
  const sentKeys = Object.keys(normalized.sentThreadFollowups);
  if (sentKeys.length > MAX_FOLLOWUP_DRAFTS) {
    const protects = (key) => normalized.sentThreadFollowups[key].edited
      && Object.hasOwn(normalized.threadFollowups, normalized.sentThreadFollowups[key].scopeKey);
    for (const staleKey of [...sentKeys.filter((key) => !protects(key)), ...sentKeys.filter(protects)]
      .slice(0, sentKeys.length - MAX_FOLLOWUP_DRAFTS)) {
      delete normalized.sentThreadFollowups[staleKey];
    }
  }
  const dropOrphanRestorations = () => {
    for (const scopeKey of Object.keys(normalized.threadFollowupRestorations)) {
      if (!(scopeKey in normalized.threadFollowups)) delete normalized.threadFollowupRestorations[scopeKey];
    }
  };
  dropOrphanRestorations();
  while (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_COMPOSER_DRAFT_BYTES) {
    const [staleKey] = Object.keys(normalized.threadFollowups);
    if (!staleKey) break;
    delete normalized.threadFollowups[staleKey];
    dropOrphanRestorations();
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_COMPOSER_DRAFT_BYTES) {
    throw new TypeError("Composer drafts exceed the local persistence limit.");
  }
  return normalized;
}

export function registerComposerDraftIpc({ ipcMain, settings }) {
  ipcMain.handle("relayer:composer-drafts-read", async () => {
    const saved = await settings.read();
    return normalizeComposerDrafts(saved.composerDrafts);
  });
  ipcMain.handle("relayer:composer-drafts-write", async (_event, value) => {
    const composerDrafts = normalizeComposerDrafts(value);
    await settings.update((current) => ({ ...current, composerDrafts }));
    return composerDrafts;
  });
}

function validLayerSelection(key, nodeId) {
  if (typeof key !== "string" || key.length > 256 || typeof nodeId !== "string" || nodeId.length > 64) return false;
  try {
    const ids = JSON.parse(key);
    return Array.isArray(ids) && ids.length === 3
      && [...ids, nodeId].every((id) => typeof id === "string" && /^[1-9]\d*$/.test(id));
  } catch { return false; }
}

function layerSelectionEntries(value) {
  return Array.isArray(value) ? value.filter((entry) => (
    Array.isArray(entry) && entry.length === 2 && validLayerSelection(...entry)
  )).slice(-512) : [];
}

export function registerWorkspaceLayoutIpc({ ipcMain, settings }) {
  const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0.2 && value <= 0.8;
  ipcMain.handle("relayer:workspace-layout-read", async () => {
    const value = (await settings.read()).workspaceSplitRatio;
    return valid(value) ? value : 0.5;
  });
  ipcMain.handle("relayer:workspace-layout-set", async (_event, value) => {
    if (!valid(value)) throw new TypeError("Invalid workspace split ratio.");
    await settings.update((current) => ({ ...current, workspaceSplitRatio: value }));
  });
}

function validCollapsedProjectIds(value) {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && /^[1-9]\d*$/.test(id));
}

export function registerProjectSidebarIpc({ ipcMain, settings }) {
  ipcMain.handle("relayer:project-sidebar-read", async () => {
    const value = (await settings.read()).collapsedProjectIds;
    return validCollapsedProjectIds(value) ? [...new Set(value)] : [];
  });
  ipcMain.handle("relayer:project-sidebar-set", async (_event, value) => {
    if (!validCollapsedProjectIds(value)) throw new TypeError("Invalid collapsed project IDs.");
    const collapsedProjectIds = [...new Set(value)];
    await settings.update((current) => ({ ...current, collapsedProjectIds }));
  });
}

export function registerAppearanceIpc({ ipcMain, nativeTheme, settings, getWindow }) {
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: nativeTheme.themeSource }));
  ipcMain.handle("relayer:appearance-set", async (_event, appearance) => {
    if (!APPEARANCE_PREFERENCES.includes(appearance)) throw new TypeError("Invalid appearance.");
    nativeTheme.themeSource = appearance;
    getWindow()?.setBackgroundColor(windowBackgroundColor(resolvedAppearance(nativeTheme)));
    await settings.update((current) => ({ ...current, appearance }));
    return { appearance };
  });
}

export function registerLayerSelectionIpc({ ipcMain, settings }) {
  ipcMain.handle("relayer:layer-selections-read", async () => (
    layerSelectionEntries((await settings.read()).layerSelections)
  ));
  ipcMain.handle("relayer:layer-selections-remember", async (_event, { key, nodeId } = {}) => {
    if (!validLayerSelection(key, nodeId)) throw new TypeError("Invalid layer selection.");
    await settings.update((current) => {
      const entries = new Map(layerSelectionEntries(current.layerSelections));
      entries.delete(key);
      entries.set(key, nodeId);
      return { ...current, layerSelections: [...entries].slice(-512) };
    });
  });
}

export function registerSharePublishIpc({ ipcMain, coordinator }) {
  if (!coordinator) return;
  if (typeof coordinator.preflight !== "function"
    || typeof coordinator.create !== "function" || typeof coordinator.retry !== "function"
    || typeof coordinator.pending !== "function" || typeof coordinator.dismiss !== "function") {
    throw new TypeError("Share publication coordinator is invalid.");
  }
  ipcMain.handle("relayer:share-preflight", (_event, { threadId } = {}) => (
    coordinator.preflight({ threadId })
  ));
  ipcMain.handle("relayer:share-create", (_event, { threadId, title } = {}) => (
    coordinator.create({ threadId, title })
  ));
  ipcMain.handle("relayer:share-retry", (_event, { attemptReferenceId } = {}) => (
    coordinator.retry(attemptReferenceId)
  ));
  ipcMain.handle("relayer:share-pending", (_event, { threadId } = {}) => coordinator.pending({ threadId }));
  ipcMain.handle("relayer:share-dismiss", (_event, { attemptReferenceId } = {}) => (
    coordinator.dismiss(attemptReferenceId)
  ));
}

export function registerDesktopIpc({
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  credentials,
  accountChannel = credentials,
  modelCatalog,
  providerDefinitions = null,
  validateProviderOnboarding = null,
  conversationExporter,
  shareCoordinator = null,
  worktrees = null,
  settings,
  tutorial,
  updater,
  getWindow,
  presentWindow = () => {},
  beforeUpdateInstall = async () => {},
  onUpdateInstallFailure = async () => {},
}) {
  // A change notification is an announcement, never a step of the operation it
  // reports. Sending into contents that were destroyed mid-flight must not turn
  // a settled connection into a rejection, nor pre-empt the browser return.
  const notifyProvidersChanged = (change) => {
    try {
      getWindow()?.webContents.send("relayer:providers-changed", change);
    } catch {
      // The window is gone; the operation it would have described is not.
    }
  };
  const rendererBindings = new Map();
  const releaseConnection = (connectionId) => {
    const unbind = rendererBindings.get(connectionId);
    if (!unbind) return;
    rendererBindings.delete(connectionId);
    unbind();
  };
  const bindConnection = (contents, result) => {
    if (result?.status !== "pending" || !result?.connectionId) return;
    const { connectionId } = result;
    releaseConnection(connectionId);
    // Contents destroyed while the attempt was starting have already fired
    // "destroyed", so a listener added now would never run and the attempt
    // would have no owner. Settle it as their destruction would have.
    if (contents?.isDestroyed?.() === true) {
      void Promise.resolve(providerDefinitions.cancelConnection(connectionId)).catch(() => undefined);
      return;
    }
    rendererBindings.set(connectionId, bindConnectionToRenderer(
      providerDefinitions,
      contents,
      connectionId,
      () => rendererBindings.delete(connectionId),
    ));
  };

  if (credentials) {
    ipcMain.handle("relayer:account-read", () => credentials.account());
    ipcMain.handle("relayer:account-login", async () => {
      const result = await credentials.login();
      if (result?.authUrl) await shell.openExternal(result.authUrl, BROWSER_HANDOFF);
      return result?.authUrl
        ? { status: "pending", loginId: result?.loginId ?? null }
        : result;
    });
    ipcMain.handle("relayer:account-logout", () => credentials.logout());
  }
  ipcMain.handle("relayer:model-catalog-settings-open", () => modelCatalog.settingsOpened());
  ipcMain.handle("relayer:model-catalog-refresh", (_event, providerId) => modelCatalog.explicitRefresh(providerId));
  ipcMain.handle("relayer:provider-status", async () => {
    if (!providerDefinitions) return null;
    const saved = await settings.read();
    let hasCompletedOnboarding = saved.providerOnboardingComplete === true;
    if (saved.providerOnboardingComplete == null && validateProviderOnboarding) {
      hasCompletedOnboarding = Boolean(await validateProviderOnboarding());
      if (hasCompletedOnboarding) {
        await settings.update((current) => ({ ...current, providerOnboardingComplete: true }));
      }
    }
    return {
      adapters: providerDefinitions.adapters(),
      definitions: await providerDefinitions.list(),
      hasCompletedOnboarding,
    };
  });
  ipcMain.handle("relayer:provider-connect", async (event, input) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const result = await providerDefinitions.connect(input);
    await handOffToBrowser(shell, providerDefinitions, result);
    bindConnection(event?.sender, result);
    notifyProvidersChanged({
      kind: result.status === "connected" ? "connected" : "connection_pending",
      providerId: result.providerDefinition.id,
    });
    return result;
  });
  ipcMain.handle("relayer:provider-connect-complete", async (_event, { connectionId }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    // Connect and reconnect both settle here. Every terminal outcome of the
    // browser leg belongs back in Relayer, on the same terms as account
    // sign-in: a success, and a failure such as catalog discovery or runtime
    // registration, which the renderer would otherwise report behind the
    // browser. Only a still-pending attempt is unfinished and presents nothing.
    const returnToRelayer = () => {
      try { presentWindow(); } catch {
        // Window presentation is a courtesy and cannot fail a connection.
      }
    };
    let result;
    try {
      result = await providerDefinitions.completeConnection(connectionId);
    } catch (error) {
      // Settled or never ours; either way this renderer no longer guards it.
      releaseConnection(connectionId);
      // Only a failure that settled the attempt is terminal. An unknown or
      // stale connection never owned one, and a transient failure such as a
      // temporary account check leaves the attempt live in the browser, so
      // neither may pull focus out of it.
      if (isTerminalConnectionFailure(error)) returnToRelayer();
      throw error;
    }
    if (result.status !== "pending") releaseConnection(connectionId);
    notifyProvidersChanged({
      kind: result.status === "connected" ? "connected" : "connection_pending",
      providerId: result.providerDefinition.id,
    });
    if (result.status === "connected") returnToRelayer();
    return result;
  });
  ipcMain.handle("relayer:provider-connect-cancel", async (_event, { connectionId }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    releaseConnection(connectionId);
    return { cancelled: await providerDefinitions.cancelConnection(connectionId) };
  });
  ipcMain.handle("relayer:provider-rename", async (_event, { id, label }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const definition = await providerDefinitions.rename(id, label);
    notifyProvidersChanged({ kind: "renamed", providerId: definition.id });
    return definition;
  });
  ipcMain.handle("relayer:provider-logout", async (_event, { id }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const account = await providerDefinitions.logout(id);
    notifyProvidersChanged({ kind: "logged_out", providerId: id });
    return account;
  });
  ipcMain.handle("relayer:provider-reconnect", async (event, { id }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const result = await providerDefinitions.reconnect(id);
    await handOffToBrowser(shell, providerDefinitions, result);
    bindConnection(event?.sender, result);
    notifyProvidersChanged({
      kind: "reconnect_pending",
      providerId: result.providerDefinition.id,
    });
    return result;
  });
  ipcMain.handle("relayer:provider-remove", async (_event, { id }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const definition = await providerDefinitions.remove(id);
    notifyProvidersChanged({ kind: "removal_requested", providerId: definition.id });
    return definition;
  });
  ipcMain.handle("relayer:provider-onboarding-complete", async () => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    if (!validateProviderOnboarding || !await validateProviderOnboarding()) {
      throw new Error("A working default provider, family, and harness are required to continue.");
    }
    await settings.update((current) => ({ ...current, providerOnboardingComplete: true }));
    return { hasCompletedOnboarding: true };
  });
  ipcMain.handle("relayer:conversation-export", (_event, threadId) => conversationExporter.save(threadId));
  registerSharePublishIpc({ ipcMain, coordinator: shareCoordinator });
  ipcMain.handle("relayer:folder-choose", async () => {
    const selection = await dialog.showOpenDialog(getWindow(), {
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return inspectFolder(selection.filePaths[0]);
  });
  registerAppearanceIpc({ ipcMain, nativeTheme, settings, getWindow });
  if (worktrees) registerWorktreeIpc({ ipcMain, worktrees });
  registerComposerDraftIpc({ ipcMain, settings });
  registerLayerSelectionIpc({ ipcMain, settings });
  registerWorkspaceLayoutIpc({ ipcMain, settings });
  registerProjectSidebarIpc({ ipcMain, settings });
  ipcMain.handle("relayer:tutorial-read", (_event, context) => tutorial.read(context));
  ipcMain.handle("relayer:tutorial-begin-automatic", (_event, context) => tutorial.beginAutomatic(context));
  ipcMain.handle("relayer:tutorial-begin-manual", () => tutorial.beginManual());
  ipcMain.handle("relayer:tutorial-dismiss", () => tutorial.dismiss());
  ipcMain.handle("relayer:tutorial-complete", () => tutorial.complete());
  ipcMain.handle("relayer:update-status", () => updater.status());
  ipcMain.handle("relayer:update-check", () => updater.check());
  ipcMain.handle("relayer:update-download", () => updater.download());
  ipcMain.handle("relayer:update-install", async () => {
    if (updater.status().phase !== "ready") throw new Error("No verified update is ready to install.");
    try {
      const proceed = await beforeUpdateInstall();
      if (proceed === false) return { installing: false };
      updater.install();
      return { installing: true };
    } catch (error) {
      await onUpdateInstallFailure(error);
      throw error;
    }
  });
  ipcMain.handle("relayer:update-channel", async (_event, channel) => {
    const state = updater.setChannel(channel);
    await accountChannel?.setChannel(channel);
    await settings.update((current) => ({ ...current, updateChannel: channel }));
    return state;
  });
}

// Electron does not preserve custom Error properties across invoke. Keep the
// closed service code and safe recovery details in an explicit response.
export function registerWorktreeIpc({ ipcMain, worktrees }) {
  for (const method of ["inspect", "validateSelection", "plan", "create", "reconcile", "readPlan"]) {
    ipcMain.handle(`relayer:worktrees-${method}`, async (_event, input) => {
      try { return { ok: true, value: await worktrees[method](input) }; }
      catch (error) { return { ok: false, error: { code: error.code || "worktree_failed", message: error.message, details: error.details } }; }
    });
  }
}

// The artifact viewer (PRD 6.6). Only the main window may drive it; agent content
// in the viewer itself has no preload and so cannot reach these channels.
export function registerArtifactViewerIpc({ ipcMain, Menu, viewer, getWindow }) {
  const fromMainWindow = (event) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents) throw new Error("The artifact viewer belongs to the Relayer window.");
    return window;
  };
  ipcMain.handle("relayer:artifact-viewer-open", async (event, request) => {
    fromMainWindow(event);
    const { threadId, nodeId, artifact, bounds, approveServer } = request ?? {};
    // approveServer is the user's Run click on a web app's approval card (PRD 6.6.6).
    return viewer.open({ threadId, nodeId, artifact, bounds, approveServer: approveServer === true });
  });
  ipcMain.handle("relayer:artifact-viewer-bounds", (event, bounds) => {
    fromMainWindow(event);
    viewer.setBounds(bounds);
  });
  ipcMain.handle("relayer:artifact-viewer-note-begin", (event) => {
    fromMainWindow(event);
    return viewer.beginNote();
  });
  ipcMain.handle("relayer:artifact-viewer-note-end", (event) => {
    fromMainWindow(event);
    return viewer.endNote();
  });
  ipcMain.handle("relayer:artifact-viewer-close", (event) => {
    fromMainWindow(event);
    viewer.close();
  });
  ipcMain.handle("relayer:artifact-viewer-menu", (event, position) => {
    const window = fromMainWindow(event);
    const menu = Menu.buildFromTemplate([
      { label: "Open externally", click: () => { void viewer.openExternally(); } },
    ]);
    const x = Number.isFinite(position?.x) ? Math.round(position.x) : undefined;
    const y = Number.isFinite(position?.y) ? Math.round(position.y) : undefined;
    menu.popup({ window, ...(x === undefined || y === undefined ? {} : { x, y }) });
  });
}

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_REFRESH_INTERVAL_MS,
  createEnvironmentRefreshScheduler,
  createPostFlightRefreshQueue,
  desktopRailGeometry,
  environmentBackoffAfterFailure,
  environmentRefreshDelay,
  environmentRefreshNeeded,
  interactionReachedTerminal,
  latestInteractionForThread,
  resolveEnvironmentSnapshot,
} from "../desktop/renderer/src/environment-context.js";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import {
  appendLayerPath,
  rootLayerPath,
  workspaceBreadcrumbItems,
} from "../desktop/renderer/src/product-workspace/model.js";
import {
  environmentPresentation,
  inspectorEscapeShouldClose,
  interactionStatusRenderKey,
  trackedChangesLabel,
  untrackedFilesLabel,
  workspaceBreadcrumbShouldRender,
  workspaceRootAnnotationShouldRender,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("desktop environment rail", () => {
  const project = { id: 7, name: "relayer-graphcomplete" };

  it("presents Git facts without merging untracked files into line counts", () => {
    expect(environmentPresentation({
      projectId: 7,
      status: "ready",
      snapshot: {
        kind: "git",
        worktreeLabel: "8bf2",
        branch: null,
        detached: true,
        changes: { additions: 18, deletions: 4, trackedFiles: 5, untrackedFiles: 3 },
        observedAt: "2026-08-25T05:00:00Z",
      },
    }, project)).toMatchObject({
      mode: "facts",
      kind: "git",
      worktreeLabel: "8bf2",
      branch: "Detached HEAD",
      additions: 18,
      deletions: 4,
      trackedFiles: 5,
      untrackedFiles: 3,
    });
  });

  it("preserves a truthful dirty indicator for binary or mode-only tracked changes", () => {
    expect(environmentPresentation({
      projectId: 7,
      status: "ready",
      snapshot: {
        kind: "git",
        worktreeLabel: "relayer-graphcomplete",
        branch: "main",
        detached: false,
        changes: { additions: 0, deletions: 0, trackedFiles: 2, untrackedFiles: 0 },
      },
    }, project)).toMatchObject({
      additions: 0,
      deletions: 0,
      trackedFiles: 2,
    });
    expect(productWorkspaceMarkup()).toContain('id="environmentTracked"');
    expect(trackedChangesLabel({ additions: 0, deletions: 0, trackedFiles: 1 }))
      .toBe("· 1 tracked file");
    expect(trackedChangesLabel({ additions: 0, deletions: 0, trackedFiles: 2 }))
      .toBe("· 2 tracked files");
    expect(trackedChangesLabel({ additions: 1, deletions: 0, trackedFiles: 2 })).toBe("");
    expect(trackedChangesLabel({ additions: 0, deletions: 0, trackedFiles: 0 })).toBe("");
    expect(untrackedFilesLabel(0)).toBe("0 files");
    expect(untrackedFilesLabel(1)).toBe("1 file");
    expect(untrackedFilesLabel(2)).toBe("2 files");
  });

  it("keeps standalone, loading, folder, unavailable, and request errors honest", () => {
    expect(environmentPresentation(null, null)).toMatchObject({
      mode: "message",
      message: "No project folder",
    });
    expect(environmentPresentation(null, project).mode).toBe("loading");
    expect(environmentPresentation({
      projectId: 7,
      status: "ready",
      snapshot: { kind: "folder", worktreeLabel: "notes" },
    }, project)).toMatchObject({
      mode: "facts",
      kind: "folder",
      message: "Not a Git repository",
    });
    expect(environmentPresentation({
      projectId: 7,
      status: "ready",
      snapshot: {
        kind: "unavailable",
        unavailableReason: { code: "path_unavailable", message: "Folder cannot be read" },
      },
    }, project)).toMatchObject({
      mode: "facts",
      kind: "unavailable",
      worktreeLabel: "relayer-graphcomplete",
      message: "Folder cannot be read",
    });
    expect(environmentPresentation({
      projectId: 7,
      status: "error",
      error: "Request timed out",
    }, project).message).toBe("Request timed out");
  });

  it("keeps retained Git, folder, and unavailable snapshots visible after refresh errors", () => {
    const retained = (snapshot) => environmentPresentation({
      projectId: 7,
      status: "error",
      error: "Refresh timed out",
      snapshot,
    }, project);
    expect(retained({
      kind: "git",
      worktreeLabel: "8bf2",
      branch: "main",
      detached: false,
      changes: { additions: 3, deletions: 1, trackedFiles: 1, untrackedFiles: 0 },
    })).toMatchObject({
      mode: "facts",
      kind: "git",
      worktreeLabel: "8bf2",
      stale: true,
      staleMessage: "Refresh timed out",
    });
    expect(retained({ kind: "folder", worktreeLabel: "notes" })).toMatchObject({
      mode: "facts",
      kind: "folder",
      stale: true,
    });
    expect(retained({
      kind: "unavailable",
      worktreeLabel: "missing",
      unavailableReason: { message: "Folder cannot be read" },
    })).toMatchObject({
      mode: "facts",
      kind: "unavailable",
      stale: true,
      message: "Folder cannot be read",
    });
  });

  it("throttles background refreshes while allowing bounded explicit refreshes", () => {
    const now = 20_000;
    expect(environmentRefreshNeeded({
      currentProjectId: 7,
      requestedProjectId: 7,
      lastRequestedAt: now - 500,
      now,
    })).toBe(false);
    expect(environmentRefreshNeeded({
      currentProjectId: 7,
      requestedProjectId: 7,
      lastRequestedAt: now - ENVIRONMENT_REFRESH_INTERVAL_MS,
      now,
    })).toBe(true);
    expect(environmentRefreshNeeded({
      currentProjectId: 7,
      requestedProjectId: 7,
      lastRequestedAt: now - 500,
      now,
      force: true,
      minimumAgeMs: 1_000,
    })).toBe(false);
    expect(environmentRefreshNeeded({
      currentProjectId: 7,
      requestedProjectId: 8,
      lastRequestedAt: now,
      now,
    })).toBe(true);
    expect(environmentRefreshNeeded({ requestedProjectId: null, now, lastRequestedAt: 0 })).toBe(false);
  });

  it("applies capped exponential error backoff to background and focus refreshes", () => {
    const now = 100_000;
    const first = environmentBackoffAfterFailure(0, now);
    const second = environmentBackoffAfterFailure(first.failureCount, first.nextAttemptAt);
    const capped = environmentBackoffAfterFailure(20, now);
    expect(first).toMatchObject({ failureCount: 1, delayMs: 5_000, nextAttemptAt: 105_000 });
    expect(second).toMatchObject({ failureCount: 2, delayMs: 10_000, nextAttemptAt: 115_000 });
    expect(capped.delayMs).toBe(60_000);
    expect(environmentRefreshNeeded({
      currentProjectId: 7,
      requestedProjectId: 7,
      lastRequestedAt: 95_000,
      nextAttemptAt: 110_000,
      now: 105_000,
    })).toBe(false);
    expect(environmentRefreshNeeded({
      currentProjectId: 7,
      requestedProjectId: 7,
      lastRequestedAt: 95_000,
      nextAttemptAt: 110_000,
      now: 110_000,
    })).toBe(true);
    expect(environmentRefreshNeeded({
      currentProjectId: 7,
      requestedProjectId: 7,
      lastRequestedAt: 103_000,
      nextAttemptAt: 160_000,
      now: 105_000,
      force: true,
      minimumAgeMs: 1_000,
    })).toBe(false);
    expect(environmentRefreshNeeded({
      currentProjectId: 7,
      requestedProjectId: 7,
      lastRequestedAt: 103_000,
      nextAttemptAt: 160_000,
      now: 160_000,
      force: true,
      minimumAgeMs: 1_000,
    })).toBe(true);
    expect(environmentRefreshDelay({
      lastRequestedAt: 103_000,
      nextAttemptAt: 160_000,
      now: 105_000,
    })).toBe(55_000);
    expect(environmentRefreshDelay({
      lastRequestedAt: 103_000,
      nextAttemptAt: 0,
      now: 110_000,
    })).toBe(0);
  });

  it("schedules one active refresh at the throttle or backoff boundary", () => {
    const scheduled = [];
    const cleared = [];
    const scheduler = createEnvironmentRefreshScheduler({
      setTimer(callback, delayMs) {
        const timer = { callback, delayMs };
        scheduled.push(timer);
        return timer;
      },
      clearTimer(timer) {
        cleared.push(timer);
      },
    });
    const refreshed = [];
    expect(scheduler.schedule({
      eligible: true,
      projectId: 7,
      lastRequestedAt: 100_000,
      nextAttemptAt: 120_000,
      now: 105_000,
      refresh: (projectId) => refreshed.push(projectId),
    })).toBe(15_000);
    expect(scheduler.schedule({
      eligible: true,
      projectId: 7,
      lastRequestedAt: 110_000,
      nextAttemptAt: 0,
      now: 112_000,
      refresh: (projectId) => refreshed.push(projectId),
    })).toBe(3_000);
    expect(cleared).toEqual([scheduled[0]]);
    scheduled[1].callback();
    expect(refreshed).toEqual([7]);
    expect(scheduler.schedule({
      eligible: false,
      projectId: 7,
      lastRequestedAt: 0,
      nextAttemptAt: 0,
      now: 0,
      refresh: () => {},
    })).toBe(false);
    expect(cleared).toHaveLength(1);
  });

  it("re-arms three exact five-second refresh intervals with controlled timers", () => {
    const scheduled = [];
    const scheduler = createEnvironmentRefreshScheduler({
      setTimer(callback, delayMs) {
        const timer = { callback, delayMs };
        scheduled.push(timer);
        return timer;
      },
      clearTimer() {},
    });
    let now = 100_000;
    let refreshes = 0;
    const scheduleNext = () => scheduler.schedule({
      eligible: true,
      projectId: 7,
      lastRequestedAt: now,
      nextAttemptAt: 0,
      now,
      refresh() {
        refreshes += 1;
        now += ENVIRONMENT_REFRESH_INTERVAL_MS;
        scheduleNext();
      },
    });

    scheduleNext();
    for (let index = 0; index < 3; index += 1) {
      expect(scheduled[index].delayMs).toBe(ENVIRONMENT_REFRESH_INTERVAL_MS);
      scheduled[index].callback();
    }
    expect(refreshes).toBe(3);
  });

  it("retains the last good snapshot for retryable unavailable responses", () => {
    const good = {
      kind: "git",
      worktreeLabel: "8bf2",
      branch: "main",
      changes: { additions: 3, deletions: 1, trackedFiles: 1, untrackedFiles: 0 },
    };
    expect(resolveEnvironmentSnapshot({
      kind: "unavailable",
      unavailableReason: { code: "git_timeout", message: "Git inspection timed out" },
    }, good)).toEqual({
      status: "error",
      snapshot: good,
      error: "Git inspection timed out",
      retryable: true,
    });
    expect(resolveEnvironmentSnapshot({
      kind: "unavailable",
      unavailableReason: { code: "inspection_capacity", message: "Inspector is busy" },
    })).toMatchObject({
      status: "error",
      snapshot: { kind: "unavailable" },
      retryable: true,
    });
  });

  it("replaces stale context for durable missing and retargeted folder states", () => {
    const good = { kind: "git", worktreeLabel: "8bf2", branch: "main" };
    for (const code of ["path_unavailable", "path_retargeted"]) {
      const unavailable = {
        kind: "unavailable",
        worktreeLabel: "relayer-graphcomplete",
        unavailableReason: { code, message: "Folder identity changed" },
      };
      expect(resolveEnvironmentSnapshot(unavailable, good)).toEqual({
        status: "ready",
        snapshot: unavailable,
        error: null,
        retryable: false,
      });
    }
  });

  it("recognizes exactly one latest-interaction terminal transition", () => {
    const interactions = [
      { id: 2, threadId: 4, sequence: 2, completionStatus: "running" },
      { id: 1, threadId: 4, sequence: 1, completionStatus: "accepted" },
      { id: 3, threadId: 5, sequence: 1, completionStatus: "accepted" },
    ];
    expect(latestInteractionForThread(interactions, 4).id).toBe(2);
    expect(interactionReachedTerminal(
      interactions[0],
      { ...interactions[0], completionStatus: "accepted" },
    )).toBe(true);
    expect(interactionReachedTerminal(
      interactions[1],
      { ...interactions[0], completionStatus: "accepted" },
    )).toBe(false);
  });

  it("queues exactly one forced refresh after a same-project request settles", async () => {
    const queue = createPostFlightRefreshQueue();
    let resolveFirst;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    let refreshes = 1;
    queue.queue(7, true);
    queue.queue(7, true);
    const completion = first.then(() => {
      if (queue.consume(7, 7, true)) refreshes += 1;
    });
    resolveFirst();
    await completion;
    expect(refreshes).toBe(2);
    expect(queue.consume(7, 7, true)).toBe(false);

    queue.queue(7, true);
    expect(queue.consume(7, 8, true)).toBe(false);
    queue.queue(7, true);
    queue.clear();
    expect(queue.consume(7, 7, true)).toBe(false);
  });

  it("updates selected interaction status only when identity or lifecycle state changes", () => {
    const running = { id: 8, completionStatus: "running" };
    expect(interactionStatusRenderKey(running, "accepted")).toBe("8:running");
    expect(interactionStatusRenderKey({ ...running }, "failed"))
      .toBe(interactionStatusRenderKey(running, "accepted"));
    expect(interactionStatusRenderKey({ ...running, completionStatus: "accepted" }, "running"))
      .toBe("8:accepted");
    expect(interactionStatusRenderKey({ id: 9, completionStatus: "running" }, "running"))
      .toBe("9:running");
  });

  it("lets only the topmost surface consume Escape before restoring graph focus", () => {
    const base = {
      key: "Escape",
      settingsMenuOpen: false,
      turnPopoverOpen: false,
      modelPickerOpen: false,
      approvalOwnsFocus: false,
      inspectorOpen: true,
    };
    expect(inspectorEscapeShouldClose(base)).toBe(true);
    expect(inspectorEscapeShouldClose({ ...base, settingsMenuOpen: true })).toBe(false);
    expect(inspectorEscapeShouldClose({ ...base, turnPopoverOpen: true })).toBe(false);
    expect(inspectorEscapeShouldClose({ ...base, modelPickerOpen: true })).toBe(false);
    expect(inspectorEscapeShouldClose({ ...base, approvalOwnsFocus: true })).toBe(false);
    expect(inspectorEscapeShouldClose({ ...base, annotationRatingExpanded: true })).toBe(false);
    expect(inspectorEscapeShouldClose({ ...base, inspectorOpen: false })).toBe(false);
  });

  it("uses one structural rail and preserves the existing inspector beneath Environment", async () => {
    const markup = productWorkspaceMarkup();
    const environmentStart = markup.indexOf('id="environmentPanel"');
    const inspectorStart = markup.indexOf('id="inspector"');
    expect(markup).toContain('class="workspace-layout"');
    expect(markup).toContain('class="workspace-layout" data-review-capture="workspace" role="region"');
    expect(markup).not.toContain('class="thread-workspace" data-review-capture="workspace"');
    expect(environmentStart).toBeGreaterThan(markup.indexOf('id="interactionBanner"'));
    expect(inspectorStart).toBeGreaterThan(environmentStart);
    expect(markup).toContain('id="interactionStatus" role="status"');
    expect(markup).not.toContain("Ready");
    expect(markup).not.toContain("Successful checks");
    expect(markup).not.toContain("Codex · Ask");

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toContain("--inspector:340px");
    expect(styles).toContain("grid-template-columns:minmax(0,1fr) var(--inspector)");
    // The workspace grid clears the window chrome instead of starting flush
    // against it, and the top inset matches the right one.
    expect(styles).toContain("padding:12px 12px 0 0");
    expect(styles).toContain("padding:12px 12px 12px");
    expect(styles).not.toContain("padding:0 12px 0 0");
    expect(styles).toContain('html[data-theme="light"] .workspace-breadcrumb.root-annotation-only{background:transparent}');
    expect(styles).toContain(".environment-panel{grid-column:2;grid-row:1 / 3");
    expect(styles).toContain(".interaction-banner{grid-column:1;grid-row:2;margin:8px 0 12px 12px");
    expect(styles).toContain(".environment-panel{grid-column:2;grid-row:1 / 3;margin:0 0 12px");
    expect(styles).toContain(".thread-workspace{grid-column:1 / -1;grid-row:3");
    expect(styles).toContain(".inspector{width:var(--inspector)");
    expect(styles).not.toContain(".inspector{position:absolute");
    expect(styles).not.toContain("ResizeObserver");
    expect(styles).toContain("@media(prefers-reduced-transparency:reduce)");
    expect(styles).toContain("@media(forced-colors:active)");
    expect(styles).toContain("--warning:#e3bd62");
    expect(styles).toContain("--warning:#92400e");
    expect(styles).toContain(".environment-stale{color:var(--warning)}");
    expect(styles).toContain("@media(min-width:761px) and (max-width:1100px)");
    expect(styles).toContain(".interaction-banner p{margin:0;display:-webkit-box;");
    expect(styles).toContain("-webkit-line-clamp:2");
    expect(styles).toContain("max-height:2.7em;overflow:hidden");
    const workspaceSource = await readFile(
      new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url),
      "utf8",
    );
    expect(workspaceSource).toContain('$("#interactionText").title = interactionText;');
    expect(desktopRailGeometry(1100)).toMatchObject({
      stacked: true,
      sidebarWidth: 244,
      railWidth: null,
      leftColumnWidth: 832,
    });
    expect(desktopRailGeometry(1101)).toMatchObject({
      stacked: false,
      sidebarWidth: 244,
      railWidth: 340,
      leftColumnWidth: 493,
    });
    expect(desktopRailGeometry(2998)).toMatchObject({
      stacked: false,
      railWidth: 340,
      leftColumnWidth: 2390,
    });
  });

  it("removes the root-only Response strip but keeps nested graph navigation", () => {
    const rootLayer = { layer: { id: 100 }, nodes: [], edges: [], actions: [] };
    const interaction = {
      id: 2,
      threadId: 7,
      completionOutput: { rootLayer },
    };
    const thread = { id: 7 };
    const state = {
      interactions: [interaction],
      currentInteractionId: interaction.id,
      visibleLayer: rootLayer,
      nodes: [],
    };
    const rootPath = rootLayerPath(interaction);
    const rootItems = workspaceBreadcrumbItems(state, thread, { layerPath: rootPath });

    expect(rootItems.map((item) => item.label)).toEqual(["Response"]);
    expect(workspaceBreadcrumbShouldRender(rootItems)).toBe(false);
    expect(workspaceRootAnnotationShouldRender(rootItems, false)).toBe(false);
    expect(workspaceRootAnnotationShouldRender(rootItems, true)).toBe(true);
    expect(workspaceBreadcrumbShouldRender([])).toBe(false);
    expect(workspaceRootAnnotationShouldRender([], true)).toBe(false);

    const nestedPath = appendLayerPath(rootPath, {
      id: 501,
      kind: "navigate",
      sourceNodeId: 10,
      targetLayerId: 101,
    }, { id: 10, title: "Architecture", icon: "network" });
    state.visibleLayer = { layer: { id: 101 }, nodes: [], edges: [], actions: [] };
    const nestedItems = workspaceBreadcrumbItems(state, thread, { layerPath: nestedPath });
    expect(nestedItems.map((item) => item.label)).toEqual(["Response", "Architecture"]);
    expect(workspaceBreadcrumbShouldRender(nestedItems)).toBe(true);

    state.visibleLayer = { layer: { id: 999 }, nodes: [], edges: [], actions: [] };
    const fallbackItems = workspaceBreadcrumbItems(state, thread, { layerPath: rootPath });
    expect(fallbackItems.map((item) => item.label)).toEqual(["Layer"]);
    expect(workspaceBreadcrumbShouldRender(fallbackItems)).toBe(true);
    expect(workspaceRootAnnotationShouldRender(fallbackItems, true)).toBe(false);
  });
});

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

  it("resolves and presents every snapshot state honestly, retaining stale data and replacing durable folder changes", () => {
    const good = {
      kind: "git",
      worktreeLabel: "8bf2",
      branch: "main",
      changes: { additions: 3, deletions: 1, trackedFiles: 1, untrackedFiles: 0 },
    };

    // Snapshot resolution: retryable unavailable responses keep the last
    // good snapshot, durable folder changes replace it.
    expect(resolveEnvironmentSnapshot({
      kind: "unavailable",
      unavailableReason: { code: "git_timeout", message: "Git inspection timed out" },
    }, good), "retryable git timeouts retain the last good snapshot").toEqual({
      status: "error",
      snapshot: good,
      error: "Git inspection timed out",
      retryable: true,
    });
    expect(resolveEnvironmentSnapshot({
      kind: "unavailable",
      unavailableReason: { code: "inspection_capacity", message: "Inspector is busy" },
    }), "retryable capacity errors stay retryable without a stale snapshot").toMatchObject({
      status: "error",
      snapshot: { kind: "unavailable" },
      retryable: true,
    });
    for (const code of ["path_unavailable", "path_retargeted"]) {
      const unavailable = {
        kind: "unavailable",
        worktreeLabel: "relayer-graphcomplete",
        unavailableReason: { code, message: "Folder identity changed" },
      };
      expect(resolveEnvironmentSnapshot(unavailable, good), `${code}: durable folder changes replace stale context`).toEqual({
        status: "ready",
        snapshot: unavailable,
        error: null,
        retryable: false,
      });
    }

    // Presentation contract: one data row per honest state.
    const retained = (snapshot) => environmentPresentation({
      projectId: 7,
      status: "error",
      error: "Refresh timed out",
      snapshot,
    }, project);
    const cases = [
      [
        "detached Git facts keep untracked files out of line counts",
        {
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
        },
        project,
        {
          mode: "facts",
          kind: "git",
          worktreeLabel: "8bf2",
          branch: "Detached HEAD",
          additions: 18,
          deletions: 4,
          trackedFiles: 5,
          untrackedFiles: 3,
        },
      ],
      [
        "binary or mode-only tracked changes keep a truthful dirty indicator",
        {
          projectId: 7,
          status: "ready",
          snapshot: {
            kind: "git",
            worktreeLabel: "relayer-graphcomplete",
            branch: "main",
            detached: false,
            changes: { additions: 0, deletions: 0, trackedFiles: 2, untrackedFiles: 0 },
          },
        },
        project,
        { additions: 0, deletions: 0, trackedFiles: 2 },
      ],
      [
        "a standalone window reports no project folder",
        null,
        null,
        { mode: "message", message: "No project folder" },
      ],
      [
        "a project without a snapshot stays loading",
        null,
        project,
        { mode: "loading" },
      ],
      [
        "a plain folder says it is not a Git repository",
        { projectId: 7, status: "ready", snapshot: { kind: "folder", worktreeLabel: "notes" } },
        project,
        { mode: "facts", kind: "folder", message: "Not a Git repository" },
      ],
      [
        "an unavailable folder keeps the project label and the reason",
        {
          projectId: 7,
          status: "ready",
          snapshot: {
            kind: "unavailable",
            unavailableReason: { code: "path_unavailable", message: "Folder cannot be read" },
          },
        },
        project,
        { mode: "facts", kind: "unavailable", worktreeLabel: "relayer-graphcomplete", message: "Folder cannot be read" },
      ],
      [
        "request errors surface their message verbatim",
        { projectId: 7, status: "error", error: "Request timed out" },
        project,
        { message: "Request timed out" },
      ],
      [
        "a retained Git snapshot stays visible with a stale banner after a refresh error",
        { presentation: retained({
          kind: "git",
          worktreeLabel: "8bf2",
          branch: "main",
          detached: false,
          changes: { additions: 3, deletions: 1, trackedFiles: 1, untrackedFiles: 0 },
        }) },
        null,
        { mode: "facts", kind: "git", worktreeLabel: "8bf2", stale: true, staleMessage: "Refresh timed out" },
      ],
      [
        "a retained folder snapshot stays visible after a refresh error",
        { presentation: retained({ kind: "folder", worktreeLabel: "notes" }) },
        null,
        { mode: "facts", kind: "folder", stale: true },
      ],
      [
        "a retained unavailable snapshot stays visible after a refresh error",
        { presentation: retained({
          kind: "unavailable",
          worktreeLabel: "missing",
          unavailableReason: { message: "Folder cannot be read" },
        }) },
        null,
        { mode: "facts", kind: "unavailable", stale: true, message: "Folder cannot be read" },
      ],
    ];
    expect(cases).toHaveLength(10);
    for (const [label, state, rowProject, expected] of cases) {
      const presentation = state?.presentation ?? environmentPresentation(state, rowProject);
      expect.soft(presentation, label).toMatchObject(expected);
    }

    // Change-count labels stay honest for binary/mode-only changes.
    expect(productWorkspaceMarkup(), "the workspace keeps a tracked-changes seam").toContain('id="environmentTracked"');
    const trackedCases = [
      [{ additions: 0, deletions: 0, trackedFiles: 1 }, "· 1 tracked file"],
      [{ additions: 0, deletions: 0, trackedFiles: 2 }, "· 2 tracked files"],
      [{ additions: 1, deletions: 0, trackedFiles: 2 }, ""],
      [{ additions: 0, deletions: 0, trackedFiles: 0 }, ""],
    ];
    for (const [changes, expectedLabel] of trackedCases) {
      expect.soft(trackedChangesLabel(changes), `tracked label for ${JSON.stringify(changes)}`).toBe(expectedLabel);
    }
    for (const [count, expectedLabel] of [[0, "0 files"], [1, "1 file"], [2, "2 files"]]) {
      expect.soft(untrackedFilesLabel(count), `untracked label for ${count}`).toBe(expectedLabel);
    }
  });

  it("throttles refreshes with capped backoff and schedules one live timer per boundary", async () => {
    // Throttle boundaries for background and explicit refresh requests.
    const neededCases = [
      ["a fresh background snapshot is not refreshed", { currentProjectId: 7, requestedProjectId: 7, lastRequestedAt: 19_500, now: 20_000 }, false],
      ["a snapshot older than the interval is refreshed", { currentProjectId: 7, requestedProjectId: 7, lastRequestedAt: 20_000 - ENVIRONMENT_REFRESH_INTERVAL_MS, now: 20_000 }, true],
      ["force respects the minimum age of an in-flight request", { currentProjectId: 7, requestedProjectId: 7, lastRequestedAt: 19_500, now: 20_000, force: true, minimumAgeMs: 1_000 }, false],
      ["switching projects refreshes immediately", { currentProjectId: 7, requestedProjectId: 8, lastRequestedAt: 20_000, now: 20_000 }, true],
      ["no requested project never refreshes", { requestedProjectId: null, now: 20_000, lastRequestedAt: 0 }, false],
      ["backoff gates the next attempt until its scheduled time", { currentProjectId: 7, requestedProjectId: 7, lastRequestedAt: 95_000, nextAttemptAt: 110_000, now: 105_000 }, false],
      ["backoff releases exactly at the scheduled attempt", { currentProjectId: 7, requestedProjectId: 7, lastRequestedAt: 95_000, nextAttemptAt: 110_000, now: 110_000 }, true],
      ["force cannot outrun both the minimum age and the backoff", { currentProjectId: 7, requestedProjectId: 7, lastRequestedAt: 103_000, nextAttemptAt: 160_000, now: 105_000, force: true, minimumAgeMs: 1_000 }, false],
      ["force succeeds once the backoff horizon passes", { currentProjectId: 7, requestedProjectId: 7, lastRequestedAt: 103_000, nextAttemptAt: 160_000, now: 160_000, force: true, minimumAgeMs: 1_000 }, true],
    ];
    expect(neededCases).toHaveLength(9);
    for (const [label, input, expected] of neededCases) {
      expect.soft(environmentRefreshNeeded(input), label).toBe(expected);
    }

    // Error backoff compounds exponentially and caps at one minute.
    const now = 100_000;
    const first = environmentBackoffAfterFailure(0, now);
    const second = environmentBackoffAfterFailure(first.failureCount, first.nextAttemptAt);
    const capped = environmentBackoffAfterFailure(20, now);
    expect(first, "first failure backs off five seconds").toMatchObject({ failureCount: 1, delayMs: 5_000, nextAttemptAt: 105_000 });
    expect(second, "the second failure doubles the backoff").toMatchObject({ failureCount: 2, delayMs: 10_000, nextAttemptAt: 115_000 });
    expect(capped.delayMs, "backoff caps at sixty seconds").toBe(60_000);

    // The scheduler delay honors the later of the throttle and backoff bounds.
    const delayCases = [
      ["the delay waits for the backoff horizon", { lastRequestedAt: 103_000, nextAttemptAt: 160_000, now: 105_000 }, 55_000],
      ["no pending attempt means no delay", { lastRequestedAt: 103_000, nextAttemptAt: 0, now: 110_000 }, 0],
    ];
    for (const [label, input, expected] of delayCases) {
      expect.soft(environmentRefreshDelay(input), label).toBe(expected);
    }

    // One live timer: rescheduling clears the previous timer, ineligible
    // requests schedule nothing, and the fired timer refreshes its project.
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
    }), "the backoff boundary sets the first timer fifteen seconds out").toBe(15_000);
    expect(scheduler.schedule({
      eligible: true,
      projectId: 7,
      lastRequestedAt: 110_000,
      nextAttemptAt: 0,
      now: 112_000,
      refresh: (projectId) => refreshed.push(projectId),
    }), "the throttle boundary replaces it with a three-second timer").toBe(3_000);
    expect(cleared, "rescheduling clears exactly the superseded timer").toEqual([scheduled[0]]);
    scheduled[1].callback();
    expect(refreshed, "the live timer refreshes its own project").toEqual([7]);
    expect(scheduler.schedule({
      eligible: false,
      projectId: 7,
      lastRequestedAt: 0,
      nextAttemptAt: 0,
      now: 0,
      refresh: () => {},
    }), "ineligible requests schedule nothing").toBe(false);
    expect(cleared, "ineligible requests clear no timers").toHaveLength(1);

    // The re-armed loop keeps the exact five-second interval across refreshes.
    const intervalTimers = [];
    const rearmingScheduler = createEnvironmentRefreshScheduler({
      setTimer(callback, delayMs) {
        const timer = { callback, delayMs };
        intervalTimers.push(timer);
        return timer;
      },
      clearTimer() {},
    });
    let intervalNow = 100_000;
    let refreshes = 0;
    const scheduleNext = () => rearmingScheduler.schedule({
      eligible: true,
      projectId: 7,
      lastRequestedAt: intervalNow,
      nextAttemptAt: 0,
      now: intervalNow,
      refresh() {
        refreshes += 1;
        intervalNow += ENVIRONMENT_REFRESH_INTERVAL_MS;
        scheduleNext();
      },
    });
    scheduleNext();
    for (let index = 0; index < 3; index += 1) {
      expect(intervalTimers[index].delayMs, `re-arm ${index + 1} keeps the exact five-second interval`).toBe(ENVIRONMENT_REFRESH_INTERVAL_MS);
      intervalTimers[index].callback();
    }
    expect(refreshes, "three refreshes fire from the re-armed timers").toBe(3);

    // The post-flight queue keeps exactly one forced refresh per settled
    // same-project request.
    const queue = createPostFlightRefreshQueue();
    let resolveFirst;
    const firstRequest = new Promise((resolve) => { resolveFirst = resolve; });
    let queueRefreshes = 1;
    queue.queue(7, true);
    queue.queue(7, true);
    const completion = firstRequest.then(() => {
      if (queue.consume(7, 7, true)) queueRefreshes += 1;
    });
    resolveFirst();
    await completion;
    expect(queueRefreshes, "duplicate queues collapse into one forced refresh").toBe(2);
    expect(queue.consume(7, 7, true), "the forced refresh is consumed exactly once").toBe(false);
    queue.queue(7, true);
    expect(queue.consume(7, 8, true), "a different project cannot consume the queued refresh").toBe(false);
    queue.queue(7, true);
    queue.clear();
    expect(queue.consume(7, 7, true), "clearing drops the queued refresh").toBe(false);
  });

  it("keeps the workspace rail structural and its interaction surfaces honest", async () => {
    // Interaction model: one latest interaction, one terminal transition.
    const interactions = [
      { id: 2, threadId: 4, sequence: 2, completionStatus: "running" },
      { id: 1, threadId: 4, sequence: 1, completionStatus: "accepted" },
      { id: 3, threadId: 5, sequence: 1, completionStatus: "accepted" },
    ];
    expect(latestInteractionForThread(interactions, 4).id, "the highest sequence wins for its thread").toBe(2);
    expect(interactionReachedTerminal(
      interactions[0],
      { ...interactions[0], completionStatus: "accepted" },
    ), "running to accepted is the terminal transition").toBe(true);
    expect(interactionReachedTerminal(
      interactions[1],
      { ...interactions[0], completionStatus: "accepted" },
    ), "an already-terminal interaction never transitions again").toBe(false);

    // The status render key changes only on identity or lifecycle changes.
    const running = { id: 8, completionStatus: "running" };
    expect(interactionStatusRenderKey(running, "accepted"), "status updates keep the selected render key").toBe("8:running");
    expect(interactionStatusRenderKey({ ...running }, "failed"), "unrelated status edits do not re-render")
      .toBe(interactionStatusRenderKey(running, "accepted"));
    expect(interactionStatusRenderKey({ ...running, completionStatus: "accepted" }, "running"), "lifecycle changes re-render").toBe("8:accepted");
    expect(interactionStatusRenderKey({ id: 9, completionStatus: "running" }, "running"), "identity changes re-render").toBe("9:running");

    // Escape consumption: only the topmost surface may take it.
    const escapeBase = {
      key: "Escape",
      settingsMenuOpen: false,
      turnPopoverOpen: false,
      modelPickerOpen: false,
      approvalOwnsFocus: false,
      inspectorOpen: true,
    };
    const escapeCases = [
      ["the open inspector consumes Escape", escapeBase, true],
      ["the settings menu outranks the inspector", { ...escapeBase, settingsMenuOpen: true }, false],
      ["the turn popover outranks the inspector", { ...escapeBase, turnPopoverOpen: true }, false],
      ["the model picker outranks the inspector", { ...escapeBase, modelPickerOpen: true }, false],
      ["approval focus outranks the inspector", { ...escapeBase, approvalOwnsFocus: true }, false],
      ["an expanded annotation rating outranks the inspector", { ...escapeBase, annotationRatingExpanded: true }, false],
      ["a closed inspector cannot consume Escape", { ...escapeBase, inspectorOpen: false }, false],
    ];
    for (const [label, state, expected] of escapeCases) {
      expect.soft(inspectorEscapeShouldClose(state), label).toBe(expected);
    }

    // Structural rail: one layout, environment above inspector, no legacy strips.
    const markup = productWorkspaceMarkup();
    const environmentStart = markup.indexOf('id="environmentPanel"');
    const inspectorStart = markup.indexOf('id="inspector"');
    expect(markup, "the workspace keeps the structural layout class").toContain('class="workspace-layout"');
    expect(markup, "the layout carries the review-capture region role").toContain('class="workspace-layout" data-review-capture="workspace" role="region"');
    expect(markup, "the legacy thread-workspace capture class is gone").not.toContain('class="thread-workspace" data-review-capture="workspace"');
    expect(environmentStart, "the environment panel sits below the interaction banner").toBeGreaterThan(markup.indexOf('id="interactionBanner"'));
    expect(inspectorStart, "the inspector stays beneath the environment panel").toBeGreaterThan(environmentStart);
    expect(markup, "the interaction status keeps its live region").toContain('id="interactionStatus" role="status"');
    expect(markup, "no baked-in Ready placeholder").not.toContain("Ready");
    expect(markup, "no baked-in Successful checks placeholder").not.toContain("Successful checks");
    expect(markup, "no baked-in Codex · Ask placeholder").not.toContain("Codex · Ask");

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    for (const pin of [
      "--inspector:340px",
      "grid-template-columns:minmax(0,1fr) var(--inspector)",
      "padding:0 12px 0 0",
      "padding:0 12px 12px",
      'html[data-theme="light"] .workspace-breadcrumb.root-annotation-only{background:transparent}',
      ".environment-panel{grid-column:2;grid-row:1 / 3",
      ".interaction-banner{grid-column:1;grid-row:2;margin:8px 0 12px 12px",
      ".environment-panel{grid-column:2;grid-row:1 / 3;margin:0 0 12px",
      ".thread-workspace{grid-column:1 / -1;grid-row:3",
      ".inspector{width:var(--inspector)",
      "@media(prefers-reduced-transparency:reduce)",
      "@media(forced-colors:active)",
      "--warning:#e3bd62",
      "--warning:#92400e",
      ".environment-stale{color:var(--warning)}",
      "@media(min-width:761px) and (max-width:1100px)",
      ".interaction-banner p{margin:0;display:-webkit-box;",
      "-webkit-line-clamp:2",
      "max-height:2.7em;overflow:hidden",
    ]) {
      expect(styles, `rail geometry pin missing: ${pin}`).toContain(pin);
    }
    for (const banned of [".inspector{position:absolute", "ResizeObserver"]) {
      expect(styles, `legacy rail behavior must stay removed: ${banned}`).not.toContain(banned);
    }
    const workspaceSource = await readFile(
      new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url),
      "utf8",
    );
    expect(workspaceSource, "clamped interaction text keeps its tooltip").toContain('$("#interactionText").title = interactionText;');
    const geometryCases = [
      [1100, { stacked: true, sidebarWidth: 244, railWidth: null, leftColumnWidth: 832 }],
      [1101, { stacked: false, sidebarWidth: 244, railWidth: 340, leftColumnWidth: 493 }],
      [2998, { stacked: false, railWidth: 340, leftColumnWidth: 2390 }],
    ];
    for (const [width, expected] of geometryCases) {
      expect.soft(desktopRailGeometry(width), `rail geometry at ${width}px`).toMatchObject(expected);
    }

    // Breadcrumbs: no root-only strip, nested navigation keeps its path, and a
    // missing layer falls back honestly.
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

    expect(rootItems.map((item) => item.label), "the root keeps a single Response crumb").toEqual(["Response"]);
    expect(workspaceBreadcrumbShouldRender(rootItems), "the root-only strip stays hidden").toBe(false);
    expect(workspaceRootAnnotationShouldRender(rootItems, false), "an unannotated root shows no annotation").toBe(false);
    expect(workspaceRootAnnotationShouldRender(rootItems, true), "an annotated root keeps its annotation").toBe(true);
    expect(workspaceBreadcrumbShouldRender([]), "empty crumbs never render").toBe(false);
    expect(workspaceRootAnnotationShouldRender([], true), "empty crumbs carry no annotation").toBe(false);

    const nestedPath = appendLayerPath(rootPath, {
      id: 501,
      kind: "navigate",
      sourceNodeId: 10,
      targetLayerId: 101,
    }, { id: 10, title: "Architecture", icon: "network" });
    state.visibleLayer = { layer: { id: 101 }, nodes: [], edges: [], actions: [] };
    const nestedItems = workspaceBreadcrumbItems(state, thread, { layerPath: nestedPath });
    expect(nestedItems.map((item) => item.label), "nested navigation keeps the full path").toEqual(["Response", "Architecture"]);
    expect(workspaceBreadcrumbShouldRender(nestedItems), "nested crumbs render").toBe(true);

    state.visibleLayer = { layer: { id: 999 }, nodes: [], edges: [], actions: [] };
    const fallbackItems = workspaceBreadcrumbItems(state, thread, { layerPath: rootPath });
    expect(fallbackItems.map((item) => item.label), "a missing layer falls back to a Layer crumb").toEqual(["Layer"]);
    expect(workspaceBreadcrumbShouldRender(fallbackItems), "fallback crumbs render").toBe(true);
    expect(workspaceRootAnnotationShouldRender(fallbackItems, true), "fallback crumbs carry no root annotation").toBe(false);
  });
});

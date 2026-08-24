import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import { controlActivationCompletionFor } from "../desktop/renderer/src/control-activation.js";
import { shouldPollThreadInteractions } from "../desktop/renderer/src/product-workspace/model.js";
import {
  activateHistoryControl,
  graphNodeIdentitySet,
  focusedTurnIdForRerender,
  historyNavigationPresentation,
  runStatePresentation,
  turnSelectionIntent,
  turnReviewKind,
  turnStatusPresentation,
  workspaceTurns,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("product workspace navigation controls", () => {
  it("exposes the exact Product history completion promise on the clicked control", async () => {
    const button = {};
    const completion = Promise.resolve("committed");
    const navigateHistory = vi.fn(() => completion);

    expect(activateHistoryControl(button, "back", navigateHistory)).toBe(completion);
    expect(controlActivationCompletionFor(button)).toBe(completion);
    await expect(controlActivationCompletionFor(button)).resolves.toBe("committed");
    expect(navigateHistory).toHaveBeenCalledWith("back");
  });

  it("uses the header arrows for generic history and keeps turn navigation in the banner", () => {
    const markup = productWorkspaceMarkup();
    const headerEnd = markup.indexOf("</header>");
    const bannerStart = markup.indexOf('id="interactionBanner"');

    expect(markup.indexOf('id="historyBack"')).toBeLessThan(headerEnd);
    expect(markup.indexOf('id="historyForward"')).toBeLessThan(headerEnd);
    expect(markup.indexOf('id="exportConversation"')).toBeLessThan(headerEnd);
    expect(markup).toContain('type="button" data-review-ref="export-conversation"');
    expect(markup.indexOf('id="previousTurn"')).toBeGreaterThan(bannerStart);
    expect(markup.indexOf('id="nextTurn"')).toBeGreaterThan(bannerStart);
    expect(markup).toContain('id="turnPickerButton"');
    expect(markup).toContain('aria-controls="turnPopover"');
    expect(markup).toContain('role="group" aria-label="Choose a turn"');
    expect(markup).toContain('aria-label="Graph layer path"');
    const copyHeaderStart = markup.indexOf('class="interaction-copy-header"');
    const promptStart = markup.indexOf('id="interactionText"');
    expect(markup.indexOf("Your interaction")).toBeGreaterThan(copyHeaderStart);
    expect(markup.indexOf('id="turnPicker"')).toBeGreaterThan(copyHeaderStart);
    expect(markup.indexOf('id="turnPicker"')).toBeLessThan(promptStart);
  });

  it("disables both history directions while one destination is loading", () => {
    expect(historyNavigationPresentation({
      canGoBack: true,
      canGoForward: true,
      pendingDirection: "back",
      backLabel: "Back to Thread A · Turn 2 · API",
      forwardLabel: "Forward to Thread B · Turn 1 · Response",
    })).toEqual({
      pendingDirection: "back",
      back: {
        disabled: true,
        label: "Back to Thread A · Turn 2 · API",
        loading: true,
      },
      forward: {
        disabled: true,
        label: "Forward to Thread B · Turn 1 · Response",
        loading: false,
      },
    });
  });

  it("keeps durable turns in sequence order and maps every supported status", () => {
    const turns = workspaceTurns({
      interactions: [
        { id: "other", threadId: "other", sequence: 1 },
        { id: "third", threadId: "thread", sequence: 3 },
        { id: "first", threadId: "thread", sequence: 1 },
        { id: "second", threadId: "thread", sequence: 2 },
      ],
    }, { id: "thread" });
    expect(turns.map((turn) => turn.id)).toEqual(["first", "second", "third"]);
    expect([
      "not_started",
      "running",
      "submitted",
      "accepted",
      "failed",
      "cancelled",
      "stopped",
    ].map((status) => turnStatusPresentation(status).label)).toEqual([
      "Waiting",
      "Running",
      "Running",
      "Complete",
      "Failed",
      "Cancelled",
      "Stopped",
    ]);
  });

  it("keeps unfinished imports selectable without treating immutable history as live work", () => {
    const interactions = [{ id: 1, threadId: 4, completionStatus: "running" }];
    expect(shouldPollThreadInteractions({ id: 4, imported: true }, interactions)).toBe(false);
    expect(shouldPollThreadInteractions({ id: 4, imported: false }, interactions)).toBe(true);
    expect(runStatePresentation("running", { imported: true })).toEqual({
      pending: false,
      display: "Unfinished snapshot",
    });
    expect(runStatePresentation("running", { imported: false })).toEqual({
      pending: true,
      display: "…",
    });
  });

  it("makes the current turn a no-op while direct jumps preserve stable identity", () => {
    const turns = [{ id: "one" }, { id: "two" }, { id: "three" }];
    expect(turnSelectionIntent(turns, "two", "two")).toBeNull();
    expect(turnSelectionIntent(turns, "two", "three")).toEqual({
      interactionId: "three",
      offset: 1,
    });
    expect(turnSelectionIntent(turns, "three", "one")).toEqual({
      interactionId: "one",
      offset: -2,
    });
  });

  it("caps the popover viewport at exactly three complete rows", async () => {
    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toContain(".turn-popover{position:absolute;");
    expect(styles).toContain("max-height:calc(52px * 3 + 2px);overflow-y:auto");
    expect(styles).toContain(".turn-option{width:100%;height:52px;");
    expect(styles).toContain(".interaction-copy-header{display:flex;align-items:center;");
  });

  it("keeps canonically restored string selections for numeric authored node IDs", () => {
    const ids = graphNodeIdentitySet([{ id: 11 }, { id: "12" }]);
    expect(ids.has("11")).toBe(true);
    expect(ids.has(String(12))).toBe(true);
  });

  it("preserves popover focus across polling renders and exposes current as a review no-op", () => {
    const activeElement = {
      closest: () => ({ dataset: { turnId: "running-turn" } }),
    };
    expect(focusedTurnIdForRerender(true, activeElement)).toBe("running-turn");
    expect(focusedTurnIdForRerender(false, activeElement)).toBeNull();
    expect(turnReviewKind(true)).toBe("control");
    expect(turnReviewKind(false)).toBe("turn");
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import { controlActivationCompletionFor } from "../desktop/renderer/src/control-activation.js";
import { shouldPollThreadInteractions } from "../desktop/renderer/src/product-workspace/model.js";
import {
  activateHistoryControl,
  approvalHistoryRenderIdentity,
  approvalHistoryRenderTransition,
  approvalHistoryReceiptIdentity,
  graphNodeIdentitySet,
  focusedTurnIdForRerender,
  historyNavigationPresentation,
  turnSelectionIntent,
  turnReviewKind,
  turnStatusPresentation,
  workspaceTurns,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("product workspace navigation controls", () => {
  it("presents approval history disclosure with identity-scoped resets and receipt-scoped retention", () => {
    const historyIdentity = approvalHistoryRenderIdentity("interactive", 10, "history");
    expect(approvalHistoryRenderTransition({
      previousIdentity: approvalHistoryRenderIdentity("interactive", 9, "history"),
      identity: historyIdentity,
      previousReceiptIdentity: "same-receipts",
      receiptIdentity: "same-receipts",
      dockMode: "history",
      wasHidden: false,
      wasHistoryOnly: true,
      open: false,
      scrollTop: 42,
    }), "a thread change reopens disclosure from the top").toEqual({ open: true, scrollTop: 0 });

    expect(approvalHistoryRenderTransition({
      previousIdentity: approvalHistoryRenderIdentity("interactive", 10, "pending"),
      identity: historyIdentity,
      previousReceiptIdentity: "same-receipts",
      receiptIdentity: "same-receipts",
      dockMode: "history",
      wasHidden: false,
      wasHistoryOnly: false,
      open: false,
      scrollTop: 42,
    }), "a dock-mode change reopens disclosure from the top").toEqual({ open: true, scrollTop: 0 });

    expect(approvalHistoryRenderIdentity("review", 10, "history"),
      "review scope keeps its own disclosure identity").not.toBe(historyIdentity);

    const identity = approvalHistoryRenderIdentity("interactive", 10, "history");
    const receipts = [{
      request: { requestId: "request-1" },
      resolution: { resolvedAt: "2026-08-26T12:00:00Z", outcome: "approved" },
    }];
    const receiptIdentity = approvalHistoryReceiptIdentity(receipts);
    expect(approvalHistoryRenderTransition({
      previousIdentity: identity,
      identity,
      previousReceiptIdentity: receiptIdentity,
      receiptIdentity,
      dockMode: "history",
      wasHidden: false,
      wasHistoryOnly: true,
      open: false,
      scrollTop: 42,
    }), "same-thread rerenders preserve collapse and scroll").toEqual({ open: false, scrollTop: 42 });

    expect(approvalHistoryRenderTransition({
      previousIdentity: identity,
      identity,
      previousReceiptIdentity: receiptIdentity,
      receiptIdentity: approvalHistoryReceiptIdentity([
        {
          request: { requestId: "request-2" },
          resolution: { resolvedAt: "2026-08-26T12:01:00Z", outcome: "denied" },
        },
        ...receipts,
      ]),
      dockMode: "history",
      wasHidden: false,
      wasHistoryOnly: true,
      open: false,
      scrollTop: 42,
    }), "a receipt change resets scroll but keeps the collapse").toEqual({ open: false, scrollTop: 0 });
  });

  it("orders turns, maps every status, and resolves selection and focus intents deterministically", () => {
    const turns = workspaceTurns({
      interactions: [
        { id: "other", threadId: "other", sequence: 1 },
        { id: "third", threadId: "thread", sequence: 3 },
        { id: "first", threadId: "thread", sequence: 1 },
        { id: "second", threadId: "thread", sequence: 2 },
      ],
    }, { id: "thread" });
    expect(turns.map((turn) => turn.id), "durable turns stay in sequence order")
      .toEqual(["first", "second", "third"]);

    const statuses = [
      ["not_started", "Waiting"],
      ["running", "Running"],
      ["submitted", "Running"],
      ["accepted", ""],
      ["succeeded", ""],
      ["failed", "Failed"],
      ["cancelled", "Cancelled"],
      ["stopped", "Stopped"],
    ];
    expect(statuses, "status presentation inventory").toHaveLength(8);
    for (const [status, label] of statuses) {
      expect.soft(turnStatusPresentation(status).label, `${status} label`).toBe(label);
    }
    expect(turnStatusPresentation("accepted"), "accepted hides its status pill")
      .toMatchObject({ hidden: true, label: "" });
    expect(turnStatusPresentation("succeeded"), "succeeded hides its status pill")
      .toMatchObject({ hidden: true, label: "" });

    expect(shouldPollThreadInteractions({ id: 4, imported: true }, [
      { id: 1, threadId: 4, completionStatus: "running" },
    ]), "unfinished imports stay selectable but never poll").toBe(false);
    expect(shouldPollThreadInteractions({ id: 4, imported: false }, [
      { id: 1, threadId: 4, completionStatus: "running" },
    ]), "live threads keep polling").toBe(true);

    const pickerTurns = [{ id: "one" }, { id: "two" }, { id: "three" }];
    expect(turnSelectionIntent(pickerTurns, "two", "two"), "selecting the current turn is a no-op").toBeNull();
    expect(turnSelectionIntent(pickerTurns, "two", "three"), "direct jumps carry a forward offset")
      .toEqual({ interactionId: "three", offset: 1 });
    expect(turnSelectionIntent(pickerTurns, "three", "one"), "direct jumps carry a backward offset")
      .toEqual({ interactionId: "one", offset: -2 });

    const ids = graphNodeIdentitySet([{ id: 11 }, { id: "12" }]);
    expect(ids.has("11"), "numeric node IDs restore as canonical strings").toBe(true);
    expect(ids.has(String(12)), "string node IDs stay addressable").toBe(true);

    const activeElement = {
      closest: () => ({ dataset: { turnId: "running-turn" } }),
    };
    expect(focusedTurnIdForRerender(true, activeElement), "popover focus survives polling renders")
      .toBe("running-turn");
    expect(focusedTurnIdForRerender(false, activeElement), "focus tracking stays off outside review")
      .toBeNull();
    expect(turnReviewKind(true), "review mode renders controls").toBe("control");
    expect(turnReviewKind(false), "normal mode renders turns").toBe("turn");
  });

  it("wires history controls and lays out turn navigation in the header, banner, and popover", async () => {
    const button = {};
    const completion = Promise.resolve("committed");
    const navigateHistory = vi.fn(() => completion);
    expect(activateHistoryControl(button, "back", navigateHistory),
      "activation returns the navigation promise").toBe(completion);
    expect(controlActivationCompletionFor(button),
      "the clicked control exposes the exact Product history completion promise").toBe(completion);
    await expect(controlActivationCompletionFor(button), "the exposed promise settles")
      .resolves.toBe("committed");
    expect(navigateHistory, "activation navigates in the clicked direction").toHaveBeenCalledWith("back");

    expect(historyNavigationPresentation({
      canGoBack: true,
      canGoForward: true,
      pendingDirection: "back",
      backLabel: "Back to Thread A · Turn 2 · API",
      forwardLabel: "Forward to Thread B · Turn 1 · Response",
    }), "a loading destination disables both history directions").toEqual({
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

    const markup = productWorkspaceMarkup();
    const headerEnd = markup.indexOf("</header>");
    const bannerStart = markup.indexOf('id="interactionBanner"');
    expect(markup.indexOf('id="historyBack"'), "Back lives in the header").toBeLessThan(headerEnd);
    expect(markup.indexOf('id="historyForward"'), "Forward lives in the header").toBeLessThan(headerEnd);
    expect(markup, "the thread title group anchors the header").toContain('class="thread-title-group"');
    expect(markup.indexOf('id="conversationSettingsButton"'), "settings trails the thread title")
      .toBeGreaterThan(markup.indexOf('id="threadTitle"'));
    expect(markup.indexOf('id="conversationSettingsButton"'), "settings stays inside the header")
      .toBeLessThan(headerEnd);
    expect(markup, "settings is accessibly labelled").toContain('aria-label="Conversation settings"');
    expect(markup, "the retired run-state badge is gone").not.toContain('id="runState"');
    expect(markup.indexOf('id="exportConversation"'), "export stays inside the header")
      .toBeLessThan(headerEnd);
    expect(markup.indexOf('id="exportConversation"'), "export trails the settings menu")
      .toBeGreaterThan(markup.indexOf('id="conversationSettingsMenu"'));
    expect(markup, "export keeps its review reference").toContain('data-review-ref="export-conversation"');
    expect(markup.indexOf('id="previousTurn"'), "turn arrows live in the banner").toBeGreaterThan(bannerStart);
    expect(markup.indexOf('id="nextTurn"'), "turn arrows live in the banner").toBeGreaterThan(bannerStart);
    expect(markup, "the turn picker button exists").toContain('id="turnPickerButton"');
    expect(markup, "the picker owns its popover").toContain('aria-controls="turnPopover"');
    expect(markup, "the picker is a labelled group").toContain('role="group" aria-label="Choose a turn"');
    expect(markup, "the breadcrumb label is present").toContain('aria-label="Graph layer path"');
    const promptStart = markup.indexOf('id="interactionText"');
    expect(markup, "no legacy interaction prompt copy").not.toContain("Your interaction");
    expect(markup, "no retired model identity element").not.toContain('id="interactionModelIdentity"');
    expect(markup.indexOf('id="turnPicker"'), "the picker trails the interaction text")
      .toBeGreaterThan(promptStart);

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles, "the title group lays out its controls").toContain(
      ".thread-title-group{display:flex;align-items:center;gap:7px;",
    );
    expect(styles, "no retired header margin hack").not.toContain(".thread-header-actions{margin-left:auto");
    expect(styles, "the popover positions absolutely").toContain(".turn-popover{position:absolute;");
    expect(styles, "the popover viewport caps at exactly three complete rows").toContain(
      "max-height:calc(52px * 3 + 2px);overflow-y:auto",
    );
    expect(styles, "every popover row is exactly 52px").toContain(".turn-option{width:100%;height:52px;");
    expect(styles, "the picker anchors itself in the title group").toContain(
      ".turn-picker{position:relative;flex:none;align-self:center;margin-left:auto}",
    );
  });
});

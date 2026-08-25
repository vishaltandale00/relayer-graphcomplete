import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  bindComposerKeydown,
  composerDisabledForState,
  composerFocusRestoration,
  composerKeydownIntent,
  composerSubmissionReady,
  graphTurnNavigationDelta,
  handleComposerKeydown,
  resizeComposerTextarea,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("product workspace keyboard behavior", () => {
  it("navigates turns only for unmodified arrows while the graph owns focus", () => {
    expect(graphTurnNavigationDelta({ key: "ArrowLeft" }, true)).toBe(-1);
    expect(graphTurnNavigationDelta({ key: "ArrowRight" }, true)).toBe(1);
    expect(graphTurnNavigationDelta({ key: "ArrowLeft" }, false)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "ArrowRight", shiftKey: true }, true)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "ArrowRight", metaKey: true }, true)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "ArrowLeft", ctrlKey: true }, true)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "ArrowLeft", altKey: true }, true)).toBeNull();
    expect(graphTurnNavigationDelta({ key: "Enter" }, true)).toBeNull();
  });

  it("makes the graph pointer-focusable without adding it to tab order", () => {
    const markup = productWorkspaceMarkup();
    expect(markup).toContain('id="graphStage" tabindex="-1"');
    expect(markup).not.toContain('id="graphStage" tabindex="0"');
  });

  it("maps Enter shortcuts while preserving multiline and IME input", () => {
    expect(composerKeydownIntent({ key: "Enter" })).toBe("submit");
    expect(composerKeydownIntent({ key: "Enter", shiftKey: true })).toBe("newline");
    expect(composerKeydownIntent({ key: "Enter", metaKey: true })).toBe("submit");
    expect(composerKeydownIntent({ key: "Enter", ctrlKey: true })).toBe("submit");
    expect(composerKeydownIntent({ key: "Enter", repeat: true })).toBe("repeat");
    expect(composerKeydownIntent({ key: "Enter", isComposing: true })).toBe("composing");
    expect(composerKeydownIntent({ key: "Enter", keyCode: 229 })).toBe("composing");
    expect(composerKeydownIntent({ key: "a" })).toBeNull();
  });

  it("submits through the bound send action on plain Enter", () => {
    let submitted = 0;
    const plainEnter = { key: "Enter", preventDefault: () => { plainEnter.prevented = true; } };
    expect(handleComposerKeydown(plainEnter, () => { submitted += 1; })).toBe("submit");
    expect(plainEnter.prevented).toBe(true);
    expect(submitted).toBe(1);

    const shiftedEnter = { key: "Enter", shiftKey: true, preventDefault: () => {} };
    expect(handleComposerKeydown(shiftedEnter, () => { submitted += 1; })).toBe("newline");
    expect(submitted).toBe(1);
  });

  it("binds plain Enter to send while leaving Shift+Enter as a newline", () => {
    const textarea = {};
    const send = { click: vi.fn() };
    bindComposerKeydown(textarea, () => send.click());

    const shiftedEnter = { key: "Enter", shiftKey: true, preventDefault: vi.fn() };
    textarea.onkeydown(shiftedEnter);
    expect(shiftedEnter.preventDefault).not.toHaveBeenCalled();
    expect(send.click).not.toHaveBeenCalled();

    const plainEnter = { key: "Enter", preventDefault: vi.fn() };
    textarea.onkeydown(plainEnter);
    expect(plainEnter.preventDefault).toHaveBeenCalledOnce();
    expect(send.click).toHaveBeenCalledOnce();
  });

  it("rejects empty and disabled submissions", () => {
    expect(composerSubmissionReady("Ask a follow-up")).toBe(true);
    expect(composerSubmissionReady("  \n ")).toBe(false);
    expect(composerSubmissionReady("Ask a follow-up", true)).toBe(false);
    expect(composerDisabledForState("running")).toBe(true);
    expect(composerDisabledForState("not_started", true, true)).toBe(false);
    expect(composerDisabledForState("waiting_for_approval")).toBe(true);
    expect(composerDisabledForState("accepted")).toBe(false);
    expect(composerDisabledForState("accepted", false)).toBe(true);
  });

  it("starts at one line, grows to its cap, and then enables vertical scrolling", async () => {
    expect(productWorkspaceMarkup()).toContain('id="threadPrompt" rows="1"');
    const textarea = { scrollHeight: 84, style: {} };
    resizeComposerTextarea(textarea);
    expect(textarea.style).toMatchObject({ height: "84px", overflowY: "hidden" });

    textarea.scrollHeight = COMPOSER_MAX_HEIGHT + 40;
    resizeComposerTextarea(textarea);
    expect(textarea.style).toMatchObject({
      height: `${COMPOSER_MAX_HEIGHT}px`,
      overflowY: "auto",
    });

    textarea.scrollHeight = 0;
    resizeComposerTextarea(textarea);
    expect(textarea.style.height).toBe(`${COMPOSER_MIN_HEIGHT}px`);

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toContain(".thread-composer textarea{flex:1;height:42px;min-height:42px;max-height:126px;resize:none;overflow-y:hidden");
    expect(styles).not.toContain(".thread-composer textarea{flex:1;min-height:42px;max-height:126px;resize:vertical");
  });

  it("places an accessible approval dock below the graph and above the composer", async () => {
    const markup = productWorkspaceMarkup();
    expect(markup.indexOf('id="graphStage"')).toBeLessThan(markup.indexOf('id="approvalDock"'));
    expect(markup.indexOf('id="approvalDock"')).toBeLessThan(markup.indexOf('id="threadComposer"'));
    expect(markup).toContain('id="approvalDock" tabindex="-1" aria-labelledby="approvalTitle"');
    expect(markup).toContain('role="group" aria-label="Resolve approval request"');
    expect(markup).toContain('id="denyApproval"');
    expect(markup).toContain('id="approveOnce"');
    expect(markup).toContain('id="approveAlways"');
    expect(markup).toContain('<small>this session</small>');
    expect(markup).toContain('id="inspector"');
    expect(markup).not.toContain("right-chat");

    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toContain(".thread-workspace{grid-column:1 / -1;grid-row:3;display:grid;grid-template-columns:minmax(0,1fr) var(--inspector)");
    expect(styles).toContain(".approval-dock{flex:none;border-top:1px solid var(--line-strong)");
    expect(styles).toContain(".approval-always small{font-size:8px");
    expect(styles).not.toContain(".approval-dock{position:absolute");
    expect(styles).toContain(".approval-dock.history-only{padding-block:9px}");
  });

  it("defers same-thread composer focus until completion is no longer running", () => {
    const waiting = composerFocusRestoration(null, {
      activeWasInside: true,
      dockThreadId: "10",
      threadId: "10",
      canCompose: true,
      promptDisabled: true,
    });
    expect(waiting).toEqual({ pendingThreadId: "10", shouldFocus: false });
    expect(composerFocusRestoration(waiting.pendingThreadId, {
      activeWasInside: false,
      dockThreadId: "10",
      threadId: "10",
      canCompose: true,
      promptDisabled: false,
    })).toEqual({ pendingThreadId: null, shouldFocus: true });
    expect(composerFocusRestoration("10", {
      activeWasInside: false,
      dockThreadId: "10",
      threadId: "11",
      canCompose: true,
      promptDisabled: false,
    })).toEqual({ pendingThreadId: null, shouldFocus: false });
  });
});

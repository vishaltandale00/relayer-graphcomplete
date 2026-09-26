import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import {
  createSharePublishController,
  shareEligibility,
  truncateShareTitle,
} from "../desktop/renderer/src/share-publish-ui.js";

function fixture({ accountStatus = "signed-in", preflightResult, result } = {}) {
  const window = new Window({ url: "http://127.0.0.1/thread" });
  window.document.body.innerHTML = `
    <main id="background"></main>
    <button id="shareConversation" type="button">Share</button>
    <button id="shareConversationMenu" type="button">Share…</button>
    <div id="shareDialog" class="hidden"></div>`;
  const thread = { id: 7, imported: false };
  const interactions = [
    { id: 1, threadId: 7, completionStatus: "accepted" },
    { id: 2, threadId: 7, completionStatus: "running" },
  ];
  let changed;
  const account = {
    read: vi.fn(async () => ({ status: accountStatus, channel: "stable" })),
    login: vi.fn(async () => ({ status: "signing-in", channel: "stable" })),
    onChanged: vi.fn((callback) => { changed = callback; return () => { changed = undefined; }; }),
  };
  const share = {
    preflight: vi.fn(async () => preflightResult ?? ({ status: "ready" })),
    create: vi.fn(async () => result ?? ({
      status: "created",
      attemptReferenceId: "SHR-ABC123",
      url: "https://share.example.test/t/abc",
    })),
    retry: vi.fn(),
  };
  const clipboard = { writeText: vi.fn(async () => {}) };
  const controller = createSharePublishController({
    root: window.document,
    getThread: () => thread,
    getInteractions: () => interactions,
    account,
    share,
    clipboard,
  });
  controller.render();
  return { window, thread, interactions, account, share, clipboard, controller, changed: (value) => changed?.(value) };
}

describe("share publish renderer boundary", () => {
  it("allows accepted history while a later response runs and closes imported/no-accepted eligibility", () => {
    expect(shareEligibility({
      thread: { id: 7, imported: false },
      interactions: [
        { threadId: 7, completionStatus: "accepted" },
        { threadId: 7, completionStatus: "running" },
      ],
    })).toEqual({ eligible: true, acceptedTurnCount: 1 });
    expect(shareEligibility({ thread: { id: 7, imported: true }, interactions: [] }))
      .toEqual({ eligible: false, acceptedTurnCount: 0, code: "share_imported_conversation" });
    expect(shareEligibility({
      thread: { id: 7, imported: false },
      interactions: [{ threadId: 7, completionStatus: "stopped" }],
    })).toEqual({ eligible: false, acceptedTurnCount: 0, code: "share_no_accepted_completion" });
  });

  it("explains a local eligibility failure before account or title input", async () => {
    const test = fixture();
    test.interactions.splice(0);
    test.controller.render();

    expect(test.window.document.querySelector("#shareConversation").getAttribute("aria-disabled")).toBe("true");
    await test.window.document.querySelector("#shareConversation").onclick();
    expect(test.window.document.querySelector("#shareDialog").textContent)
      .toContain("This thread needs an accepted response before it can be shared");
    expect(test.window.document.querySelector("#shareTitle")).toBeNull();
    expect(test.account.read).not.toHaveBeenCalled();
  });

  it("caps titles by Unicode code points instead of splitting a surrogate pair", () => {
    expect([...truncateShareTitle(`${"a".repeat(119)}😀tail`)]).toHaveLength(120);
    expect(truncateShareTitle(`${"a".repeat(119)}😀tail`)).toBe(`${"a".repeat(119)}😀`);
  });

  it("requires sign-in first and never publishes automatically when the account changes", async () => {
    const test = fixture({ accountStatus: "signed-out" });
    await test.window.document.querySelector("#shareConversation").onclick();
    expect(test.window.document.querySelector("#shareDialog").textContent).toContain("Sign in to share");

    await test.window.document.querySelector('[data-share-action="sign-in"]').onclick();
    expect(test.account.login).toHaveBeenCalledOnce();
    expect(test.share.create).not.toHaveBeenCalled();

    test.changed({ status: "signed-in", channel: "stable" });
    await vi.waitFor(() => expect(test.window.document.querySelector("#shareTitle")).not.toBeNull());
    expect(test.window.document.querySelector("#shareTitle").value).toBe("");
    expect(test.window.document.querySelector('[data-share-action="create"]').disabled).toBe(true);
    expect(test.share.create).not.toHaveBeenCalled();
  });

  it("freezes through Main only after a nonblank title and presents the simplified success dialog", async () => {
    const test = fixture();
    await test.window.document.querySelector("#shareConversation").onclick();
    const title = test.window.document.querySelector("#shareTitle");
    title.value = "  Public investigation  ";
    title.oninput();
    const create = test.window.document.querySelector('[data-share-action="create"]');
    expect(create.disabled).toBe(false);

    const publishing = create.onclick();
    expect(test.window.document.querySelector("#shareDialog").textContent).toContain("Creating link…");
    expect(test.window.document.querySelector('[data-share-action="cancel"]')).toBeNull();
    await publishing;

    expect(test.share.create).toHaveBeenCalledWith(7, "  Public investigation  ");
    const dialog = test.window.document.querySelector("#shareDialog");
    expect(dialog.textContent).toContain("Link ready");
    expect(dialog.textContent).toContain("known secrets and paths removed");
    expect(dialog.querySelector('[aria-label="Share link"]').value).toBe("https://share.example.test/t/abc");
    await dialog.querySelector('[data-share-action="copy"]').onclick();
    expect(test.clipboard.writeText).toHaveBeenCalledWith("https://share.example.test/t/abc");
  });

  it("shows only the closed reference and retry action for a generic failure", async () => {
    const test = fixture({ result: {
      status: "failed",
      code: "share_service_failed",
      retryable: true,
      attemptReferenceId: "SHR-SAFE123",
    } });
    await test.window.document.querySelector("#shareConversation").onclick();
    const title = test.window.document.querySelector("#shareTitle");
    title.value = "Public title";
    title.oninput();
    await test.window.document.querySelector('[data-share-action="create"]').onclick();

    const dialog = test.window.document.querySelector("#shareDialog");
    expect(dialog.textContent).toContain("We couldn’t create the link");
    expect(dialog.textContent).toContain("SHR-SAFE123");
    expect(dialog.textContent).not.toContain("share_service_failed");
    expect(dialog.querySelector('[data-share-action="retry"]')).not.toBeNull();
  });

  it("re-runs preflight instead of retrying a nonexistent attempt after a preflight failure", async () => {
    const test = fixture({ preflightResult: {
      status: "failed",
      code: "share_service_failed",
      retryable: true,
      attemptReferenceId: "SHR-PREFLIGHT",
    } });
    test.share.preflight
      .mockResolvedValueOnce({
        status: "failed",
        code: "share_service_failed",
        retryable: true,
        attemptReferenceId: "SHR-PREFLIGHT",
      })
      .mockResolvedValueOnce({ status: "ready" });

    await test.window.document.querySelector("#shareConversation").onclick();
    await test.window.document.querySelector('[data-share-action="retry"]').onclick();

    expect(test.share.preflight).toHaveBeenCalledTimes(2);
    expect(test.share.retry).not.toHaveBeenCalled();
    expect(test.window.document.querySelector("#shareTitle")).not.toBeNull();
  });

  it("formats quota reset in local time without offering retry", async () => {
    const test = fixture({ preflightResult: {
      status: "failed",
      code: "daily_quota_exhausted",
      retryable: false,
      resetAt: "2026-09-27T00:00:00.000Z",
      attemptReferenceId: "SHR-QUOTA01",
    } });
    await test.window.document.querySelector("#shareConversation").onclick();

    const dialog = test.window.document.querySelector("#shareDialog");
    expect(dialog.textContent).toContain("share again after");
    expect(dialog.textContent).toContain(new Date("2026-09-27T00:00:00.000Z").toLocaleString());
    expect(dialog.querySelector('[data-share-action="retry"]')).toBeNull();
    expect(dialog.querySelector("#shareTitle")).toBeNull();
    expect(test.share.create).not.toHaveBeenCalled();
  });

  it("clears owner-bound results and ignores stale publication completion after an account transition", async () => {
    let resolveCreate;
    const test = fixture();
    test.share.create.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    await test.window.document.querySelector("#shareConversation").onclick();
    const title = test.window.document.querySelector("#shareTitle");
    title.value = "Owner A title";
    title.oninput();
    const pending = test.window.document.querySelector('[data-share-action="create"]').onclick();

    test.changed({ status: "signed-out", channel: "stable" });
    expect(test.window.document.querySelector("#shareDialog").textContent).toContain("Sign in to share");
    expect(test.window.document.querySelector('[aria-label="Share link"]')).toBeNull();
    resolveCreate({
      status: "created",
      attemptReferenceId: "SHR-OWNER-A",
      url: "https://share.example.test/t/owner-a",
    });
    await pending;
    expect(test.window.document.querySelector('[aria-label="Share link"]')).toBeNull();
    expect(test.window.document.querySelector("#shareDialog").textContent).toContain("Sign in to share");
  });
});

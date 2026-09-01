import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearThreadFollowupDraft,
  pendingNewThreadDraft,
  persistPendingNewThreadDraft,
  persistThreadFollowupDraft,
  threadFollowupDraft,
} from "../desktop/renderer/src/composer-drafts.js";
import { normalizeComposerDrafts } from "../desktop/main/ipc/register-ipc.mjs";

describe("composer draft persistence", () => {
  let values;

  beforeEach(() => {
    values = new Map();
    globalThis.window = {
      localStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    };
  });

  afterEach(() => {
    delete globalThis.window;
  });

  it("retains failed-prompt tombstones without accumulating ordinary clears", () => {
    persistThreadFollowupDraft("failed:1", "retry this prompt");
    persistThreadFollowupDraft("failed:1", "", { preserveEmpty: true });

    for (let index = 0; index < 300; index += 1) {
      const key = `ordinary:${index}`;
      persistThreadFollowupDraft(key, "draft");
      persistThreadFollowupDraft(key, "");
    }

    expect(threadFollowupDraft("failed:1")).toBe("");
    expect(JSON.parse(values.get("relayerComposerDraftsV1")).threadFollowups)
      .toEqual({ "failed:1": "" });

    clearThreadFollowupDraft("failed:1");
    expect(threadFollowupDraft("failed:1")).toBeNull();

    for (let index = 0; index < 300; index += 1) {
      persistThreadFollowupDraft(`unsent:${index}`, `draft ${index}`);
    }
    const persisted = JSON.parse(values.get("relayerComposerDraftsV1")).threadFollowups;
    expect(Object.keys(persisted)).toHaveLength(256);
    expect(threadFollowupDraft("unsent:43")).toBeNull();
    expect(threadFollowupDraft("unsent:44")).toBe("draft 44");
    expect(threadFollowupDraft("unsent:299")).toBe("draft 299");
  });

  it("evicts oldest follow-ups by bytes and recovers after an oversized active draft", () => {
    for (let index = 0; index < 256; index += 1) {
      persistThreadFollowupDraft(`large:${index}`, `${index}:`.padEnd(4_096, "x"));
    }

    const persisted = JSON.parse(values.get("relayerComposerDraftsV1"));
    expect(new TextEncoder().encode(JSON.stringify(persisted)).byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(threadFollowupDraft("large:0")).toBeNull();
    expect(threadFollowupDraft("large:255")).toContain("255:");
    const normalized = normalizeComposerDrafts({
      pendingNewThread: null,
      threadFollowups: Object.fromEntries(Array.from({ length: 256 }, (_, index) => (
        [`main:${index}`, `${index}:`.padEnd(4_096, "x")]
      ))),
    });
    expect(new TextEncoder().encode(JSON.stringify(normalized)).byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(normalized.threadFollowups["main:0"]).toBeUndefined();
    expect(normalized.threadFollowups["main:255"]).toContain("255:");

    persistPendingNewThreadDraft("stable", null);
    persistPendingNewThreadDraft("x".repeat(1024 * 1024 + 1), null);
    expect(pendingNewThreadDraft()?.text).toBe("stable");
    persistPendingNewThreadDraft("recovered", null);
    expect(pendingNewThreadDraft()?.text).toBe("recovered");
  });
});

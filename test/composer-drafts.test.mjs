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

  function freshDraftStore() {
    values = new Map();
    globalThis.window = {
      localStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    };
  }

  beforeEach(() => {
    freshDraftStore();
  });

  afterEach(() => {
    delete globalThis.window;
  });

  it("keeps failed-prompt tombstones, evicts oldest drafts by bytes, and recovers from oversized writes", () => {
    persistThreadFollowupDraft("failed:1", "retry this prompt");
    persistThreadFollowupDraft("failed:1", "", { preserveEmpty: true });

    for (let index = 0; index < 300; index += 1) {
      const key = `ordinary:${index}`;
      persistThreadFollowupDraft(key, "draft");
      persistThreadFollowupDraft(key, "");
    }

    expect(threadFollowupDraft("failed:1"), "tombstone survives ordinary clears").toBe("");
    expect(JSON.parse(values.get("relayerComposerDraftsV1")).threadFollowups, "ordinary clears do not accumulate")
      .toEqual({ "failed:1": "" });

    clearThreadFollowupDraft("failed:1");
    expect(threadFollowupDraft("failed:1"), "explicit clear removes the tombstone").toBeNull();

    for (let index = 0; index < 300; index += 1) {
      persistThreadFollowupDraft(`unsent:${index}`, `draft ${index}`);
    }
    const persisted = JSON.parse(values.get("relayerComposerDraftsV1")).threadFollowups;
    expect(Object.keys(persisted), "draft cap").toHaveLength(256);
    expect(threadFollowupDraft("unsent:43"), "oldest evicted draft").toBeNull();
    expect(threadFollowupDraft("unsent:44"), "newest surviving draft").toBe("draft 44");
    expect(threadFollowupDraft("unsent:299"), "latest draft").toBe("draft 299");

    // Byte eviction runs against a fresh store so the size bound is measured in isolation.
    freshDraftStore();
    for (let index = 0; index < 256; index += 1) {
      persistThreadFollowupDraft(`large:${index}`, `${index}:`.padEnd(4_096, "x"));
    }

    const largePersisted = JSON.parse(values.get("relayerComposerDraftsV1"));
    expect(new TextEncoder().encode(JSON.stringify(largePersisted)).byteLength, "persisted byte bound")
      .toBeLessThanOrEqual(1024 * 1024);
    expect(threadFollowupDraft("large:0"), "oldest large draft evicted").toBeNull();
    expect(threadFollowupDraft("large:255"), "newest large draft kept").toContain("255:");

    const normalized = normalizeComposerDrafts({
      pendingNewThread: null,
      threadFollowups: Object.fromEntries(Array.from({ length: 256 }, (_, index) => (
        [`main:${index}`, `${index}:`.padEnd(4_096, "x")]
      ))),
    });
    expect(new TextEncoder().encode(JSON.stringify(normalized)).byteLength, "normalized byte bound")
      .toBeLessThanOrEqual(1024 * 1024);
    expect(normalized.threadFollowups["main:0"], "normalized oldest entry evicted").toBeUndefined();
    expect(normalized.threadFollowups["main:255"], "normalized newest entry kept").toContain("255:");

    persistPendingNewThreadDraft("stable", null);
    persistPendingNewThreadDraft("x".repeat(1024 * 1024 + 1), null);
    expect(pendingNewThreadDraft()?.text, "oversized draft leaves the prior draft intact").toBe("stable");
    persistPendingNewThreadDraft("recovered", null);
    expect(pendingNewThreadDraft()?.text, "store recovers after an oversized write").toBe("recovered");
  });
});

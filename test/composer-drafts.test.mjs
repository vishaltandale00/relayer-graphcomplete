import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearThreadFollowupDraft,
  persistThreadFollowupDraft,
  threadFollowupDraft,
} from "../desktop/renderer/src/composer-drafts.js";

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
});

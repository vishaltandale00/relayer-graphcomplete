import { describe, expect, it } from "vitest";

import {
  captureComposerSubmission,
  settleComposerSubmission,
} from "../desktop/renderer/src/product-workspace/composer-submission.js";

const field = (value, revision) => ({ value, revision });

function submittedDraft(overrides = {}) {
  return {
    threadId: 10,
    scopeKey: "10:100",
    prompt: field("send A", "prompt:1"),
    contexts: field([{ target: { nodeId: 3 }, annotations: ["note"] }], "contexts:1"),
    ...overrides,
  };
}

function capture(draft = submittedDraft()) {
  return captureComposerSubmission(draft);
}

function settle({
  submission = capture(),
  outcome = "succeeded",
  current = submittedDraft(),
} = {}) {
  return settleComposerSubmission({ submission, outcome, current });
}

describe("composer submission settlement", () => {
  it("clears submitted contexts without clearing the next scope prompt after refresh advances", () => {
    const result = settle({
      current: submittedDraft({
        scopeKey: "10:101",
        prompt: field("", "prompt:next-scope"),
      }),
    });

    expect(result.current).toMatchObject({
      threadId: 10,
      scopeKey: "10:101",
      prompt: { value: "", revision: "prompt:next-scope" },
    });
    expect(result.current.contexts.value).toEqual([]);
    expect(result.submittedScopeKey).toBe("10:100");
  });

  it("preserves the exact prompt, contexts, and cache after failure", () => {
    const current = submittedDraft();
    const result = settle({ outcome: "failed", current });

    expect(result.current).toBe(current);
    expect(result.current.prompt.value).toBe("send A");
    expect(result.current.contexts.value).toBe(current.contexts.value);
    expect(result.submittedScopeKey).toBeNull();
  });

  it("preserves a newer prompt while clearing only the submitted contexts", () => {
    const result = settle({
      current: submittedDraft({ prompt: field("send B", "prompt:2") }),
    });

    expect(result.current.prompt).toEqual(field("send B", "prompt:2"));
    expect(result.current.contexts.value).toEqual([]);
  });

  it("preserves newer contexts while clearing only the submitted prompt", () => {
    const newerContexts = [{ target: { nodeId: 4 }, annotations: ["new note"] }];
    const result = settle({
      current: submittedDraft({ contexts: field(newerContexts, "contexts:2") }),
    });

    expect(result.current.prompt.value).toBe("");
    expect(result.current.contexts).toEqual(field(newerContexts, "contexts:2"));
  });

  it("preserves a same-value retype when its prompt revision is newer", () => {
    const result = settle({
      current: submittedDraft({ prompt: field("send A", "prompt:2") }),
    });

    expect(result.current.prompt).toEqual(field("send A", "prompt:2"));
    expect(result.current.contexts.value).toEqual([]);
  });

  it("does not touch work in the switched-to thread", () => {
    const otherContexts = [{ target: { nodeId: 9 }, annotations: ["other"] }];
    const current = submittedDraft({
      threadId: 11,
      scopeKey: "11:200",
      prompt: field("thread B", "prompt:b1"),
      contexts: field(otherContexts, "contexts:b1"),
    });
    const result = settle({ current });

    expect(result.current).toBe(current);
    expect(result.submittedScopeKey).toBe("10:100");
  });

  it("settles field revisions idempotently", () => {
    const first = settle();

    const second = settle({
      submission: capture(),
      current: first.current,
    });
    expect(second.current).toBe(first.current);
  });
});

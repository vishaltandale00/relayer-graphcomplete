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
  it("clears only the submitted fields while a succeeded send meets newer concurrent edits", () => {
    const newerContexts = [{ target: { nodeId: 4 }, annotations: ["new note"] }];
    const cases = [
      ["scope advanced after refresh", submittedDraft({
        scopeKey: "10:101",
        prompt: field("", "prompt:next-scope"),
      }), (result, label) => {
        expect.soft(result.current, `${label}: next-scope draft untouched`).toMatchObject({
          threadId: 10,
          scopeKey: "10:101",
          prompt: { value: "", revision: "prompt:next-scope" },
        });
        expect.soft(result.current.contexts.value, `${label}: submitted contexts cleared`).toEqual([]);
      }],
      ["newer prompt revision", submittedDraft({ prompt: field("send B", "prompt:2") }), (result, label) => {
        expect.soft(result.current.prompt, `${label}: newer prompt preserved`).toEqual(field("send B", "prompt:2"));
        expect.soft(result.current.contexts.value, `${label}: submitted contexts cleared`).toEqual([]);
      }],
      ["newer contexts revision", submittedDraft({ contexts: field(newerContexts, "contexts:2") }), (result, label) => {
        expect.soft(result.current.prompt.value, `${label}: submitted prompt cleared`).toBe("");
        expect.soft(result.current.contexts, `${label}: newer contexts preserved`).toEqual(field(newerContexts, "contexts:2"));
      }],
      ["same prompt value with a newer revision", submittedDraft({ prompt: field("send A", "prompt:2") }), (result, label) => {
        expect.soft(result.current.prompt, `${label}: same-value retype preserved`).toEqual(field("send A", "prompt:2"));
        expect.soft(result.current.contexts.value, `${label}: submitted contexts cleared`).toEqual([]);
      }],
    ];
    expect(cases, "concurrent-edit settlement inventory").toHaveLength(4);
    for (const [label, current, assertRow] of cases) {
      const result = settle({ current });
      assertRow(result, label);
      expect.soft(result.submittedScopeKey, `${label}: submitted scope key`).toBe("10:100");
    }
  });

  it("preserves the draft unchanged on failure, thread switches, and repeated settlement", () => {
    const failedCurrent = submittedDraft();
    const failed = settle({ outcome: "failed", current: failedCurrent });
    expect(failed.current, "failure keeps the exact current draft").toBe(failedCurrent);
    expect(failed.current.prompt.value, "failure keeps the prompt text").toBe("send A");
    expect(failed.current.contexts.value, "failure keeps the same contexts array").toBe(failedCurrent.contexts.value);
    expect(failed.submittedScopeKey, "failure records no submitted scope").toBeNull();

    const otherContexts = [{ target: { nodeId: 9 }, annotations: ["other"] }];
    const switchedCurrent = submittedDraft({
      threadId: 11,
      scopeKey: "11:200",
      prompt: field("thread B", "prompt:b1"),
      contexts: field(otherContexts, "contexts:b1"),
    });
    const switched = settle({ current: switchedCurrent });
    expect(switched.current, "switched-to thread draft untouched").toBe(switchedCurrent);
    expect(switched.submittedScopeKey, "switched settlement still reports the submitted scope").toBe("10:100");

    const first = settle();
    const second = settle({ submission: capture(), current: first.current });
    expect(second.current, "settlement is idempotent once fields are settled").toBe(first.current);
  });
});

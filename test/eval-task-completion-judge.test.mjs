import { expect, it, vi } from "vitest";
import { COMPLETION_JUDGE_SPEC, createCompletionJudge, validateCompletionAssessment } from "../desktop/eval-main/task-completion-judge.mjs";

const assessment = { verdict: "incomplete", evidenceExplanation: "The visible shortlist does not establish desk fit.", continuationHint: "Could we check whether this fits my space?" };
it("uses the pinned restricted native constructor and passes only bounded completion evidence", async () => {
  const decide = vi.fn(async () => ({ action: assessment, usage: { input_tokens: 12 } }));
  const close = vi.fn(); const createActor = vi.fn(async () => ({ decide, close })); const controller = new AbortController();
  const runtime = { executable: "fixture", environment: {} };
  const judge = await createCompletionJudge({ runtime, signal: controller.signal, createActor });
  const input = { request: "Improve my workspace", endpoint: "Agreed plan", privateBrief: "Small desk", trajectory: [{ kind: "submission", text: "Help" }], artifactEvidence: { present: false }, screenshot: "YWJj", actorFinish: { endpointStatus: "reached" }, humanRubric: "SECRET RUBRIC", grades: "SECRET GRADE" };
  expect(await judge.evaluate(input)).toEqual({ ...assessment, usage: { input_tokens: 12 } });
  expect(createActor).toHaveBeenCalledWith({ runtime, config: COMPLETION_JUDGE_SPEC, prompt: COMPLETION_JUDGE_SPEC.promptTemplate, outputSchema: COMPLETION_JUDGE_SPEC.outputSchema });
  expect(decide.mock.calls[0][0]).toEqual(Object.fromEntries(Object.entries(input).filter(([key]) => !["humanRubric", "grades"].includes(key))));
  expect(decide.mock.calls[0][1]).toBe(controller.signal);
  expect(COMPLETION_JUDGE_SPEC.model).toBe("gpt-5.6-sol"); expect(COMPLETION_JUDGE_SPEC.modelReasoningEffort).toBe("high");
  await judge.close(); expect(close).toHaveBeenCalledOnce();
});
it("rejects malformed or contradictory results rather than converting them to completion", () => {
  for (const invalid of [null, {}, { ...assessment, verdict: "reached" }, { ...assessment, continuationHint: "" }, { ...assessment, verdict: "complete" }, { ...assessment, evidenceExplanation: " " }, { ...assessment, evidenceExplanation: "x".repeat(4001) }, { ...assessment, continuationHint: "x".repeat(401) }, { ...assessment, extra: true }]) expect(() => validateCompletionAssessment(invalid)).toThrow("invalid assessment");
  expect(validateCompletionAssessment({ ...assessment, verdict: "uncertain" }).verdict).toBe("uncertain");
  expect(validateCompletionAssessment({ ...assessment, verdict: "complete", continuationHint: "" }).verdict).toBe("complete");
});
it("fails before inference on oversized evidence and honors cancellation during native assessment", async () => {
  const controller = new AbortController(); const decide = vi.fn(async () => { controller.abort(); return { action: assessment }; });
  const judge = await createCompletionJudge({ runtime: {}, signal: controller.signal, createActor: async () => ({ decide, close: async () => {} }) });
  await expect(judge.evaluate({ request: "x", endpoint: "y", trajectory: "x".repeat(512001) })).rejects.toThrow("budget"); expect(decide).not.toHaveBeenCalled();
  await expect(judge.evaluate({ request: "x", endpoint: "y" })).rejects.toThrow(); expect(decide).toHaveBeenCalledOnce();
});
it("cleans up a native instance if cancellation wins initialization", async () => {
  const controller = new AbortController(); const close = vi.fn();
  await expect(createCompletionJudge({ runtime: {}, signal: controller.signal, createActor: async () => { controller.abort(); return { close }; } })).rejects.toThrow();
  expect(close).toHaveBeenCalledOnce();
});

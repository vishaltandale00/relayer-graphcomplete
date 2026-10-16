import { afterEach, expect, it, vi } from "vitest";
import { createRestrictedCodexActor } from "../packages/eval-runner/src/simulated-user/task-actor.ts";

const actors = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(actors.splice(0).map(actor => actor.close())); });
async function setup(run) {
  const createCodex = vi.fn(() => ({ startThread: () => ({ run }) }));
  const actor = await createRestrictedCodexActor({ runtime: { executable: "/inert/codex", environment: {} }, config: { model: "test", modelReasoningEffort: "low" }, prompt: "ordinary user", outputSchema: { type: "object" }, createCodex });
  actors.push(actor);
  return actor;
}
it("bounds a stalled native call without retrying or returning an action", async () => {
  const run = vi.fn((_input, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const actor = await setup(run);
  vi.useFakeTimers();
  const controller = new AbortController();
  const pending = actor.decide({ availableActions: [] }, controller.signal).catch(error => error);
  try {
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run.mock.calls[0][1].signal.aborted).toBe(true);
    expect(await pending).toMatchObject({ name: "TimeoutError", actorFailureStage: "execute", actorNativeDispatch: "unknown" });
    expect(run).toHaveBeenCalledTimes(1);
  } finally { controller.abort(); await pending; }
});
it("cancels native work with the outer signal and never retries", async () => {
  const run = vi.fn((_input, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const actor = await setup(run);
  const controller = new AbortController();
  const pending = actor.decide({}, controller.signal);
  const failure = expect(pending).rejects.toMatchObject({ name: "AbortError", actorFailureStage: "execute", actorNativeDispatch: "unknown" });
  controller.abort();
  await failure;
  expect(run).toHaveBeenCalledTimes(1);
});
it("rejects an already cancelled call before native dispatch", async () => {
  const run = vi.fn();
  const actor = await setup(run);
  const signal = AbortSignal.abort();
  await expect(actor.decide({}, signal)).rejects.toMatchObject({ actorFailureStage: "prepare", actorNativeDispatch: "none" });
  expect(run).not.toHaveBeenCalled();
});
it.each([
  { items: [], finalResponse: "not-json" },
  { items: [], finalResponse: undefined },
  { items: [{ type: "command_execution" }], finalResponse: "{}" },
])("records completed native dispatch but rejects unusable output: %j", async result => {
  const run = vi.fn(async () => result);
  const actor = await setup(run);
  await expect(actor.decide({})).rejects.toMatchObject({ actorFailureStage: "validate", actorNativeDispatch: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
});
it("keeps one native thread across working and settled decisions and clears call timers", async () => {
  const run = vi.fn().mockResolvedValueOnce({ items: [], finalResponse: '{"comment":"working"}' }).mockResolvedValueOnce({ items: [], finalResponse: '{"kind":"finish"}' });
  const actor = await setup(run);
  vi.useFakeTimers();
  expect(await actor.observe({})).toMatchObject({ comment: "working" });
  expect(await actor.decide({})).toMatchObject({ action: { kind: "finish" } });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[0][0][0].text).toContain("ordinary user");
  expect(run.mock.calls[1][0][0].text).not.toContain("ordinary user");
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects a late native success after cancellation without exposing an action", async () => {
  let resolveNative;
  const run = vi.fn(() => new Promise(resolve => { resolveNative = resolve; }));
  const actor = await setup(run);
  const controller = new AbortController();
  const pending = actor.decide({}, controller.signal);
  controller.abort();
  resolveNative({ items: [], finalResponse: '{"kind":"finish"}' });
  await expect(pending).rejects.toMatchObject({ name: "AbortError", actorFailureStage: "execute", actorNativeDispatch: "unknown" });
  expect(run).toHaveBeenCalledTimes(1);
});

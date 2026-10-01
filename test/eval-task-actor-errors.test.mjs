import { expect, it, vi } from "vitest";
import { TaskActorService } from "../desktop/eval-main/task-actor-service.mjs";

it("preflights the exact actor configuration before creating candidate work", async () => {
  const tasks = { create: vi.fn() };
  const resolveRuntime = vi.fn(async () => { throw Object.assign(new Error("unknown model private-secret"), { code: "actor_model_unsupported" }); });
  const service = new TaskActorService({ tasks, resolveRuntime });
  await expect(service.create({ actor: { model: "missing", modelReasoningEffort: "medium" } })).rejects.toThrow("Choose a model");
  expect(resolveRuntime).toHaveBeenCalledWith(expect.objectContaining({ model: "missing", modelReasoningEffort: "medium" }), { signal: expect.any(AbortSignal) });
  expect(tasks.create).not.toHaveBeenCalled();
});

it.each([
  [Object.assign(new Error("private-secret"), { code: "actor_control_stale" }), "stale_control"],
  [Object.assign(new Error("private-secret"), { code: "actor_control_unavailable" }), "unavailable_control"],
  [Object.assign(new Error("private-secret"), { code: "actor_invalid_action" }), "invalid_action"],
  [Object.assign(new Error("private-secret"), { code: "model_not_found" }), "unsupported_model"],
  [new Error("Model gpt-private is not supported when using this account: private-secret"), "unsupported_model"],
  [Object.assign(new Error("private-secret"), { status: 401 }), "authentication"],
  [Object.assign(new Error("private-secret"), { status: 429 }), "rate_limit"],
  [Object.assign(new Error("private-secret"), { name: "TimeoutError" }), "timeout"],
  [Object.assign(new Error("private-secret"), { name: "private-secret" }), "runtime_failure"],
])("records a safe actor runtime failure (%j)", async (error, category) => {
  const task = { id: "one", status: "active", actor: { timeoutMs: 1000, maxActions: 1 }, endpoint: "A plan", prepared: { plan: [{ prompts: ["Help me"] }] } };
  const events = [];
  const tasks = { get: () => task, actorEvent: async (_id, kind, data) => { events.push({ kind, ...data }); return { id: "event" }; }, interruptActor: async () => { task.status = "interrupted"; } };
  const service = new TaskActorService({ tasks, createActor: async () => { throw error; } });
  await service.run(task.id, {}, new AbortController().signal);
  expect(events.find(event => event.kind === "actor_error")).toMatchObject({ category });
  expect(JSON.stringify(events)).not.toContain("private-secret");
  expect(task.status).toBe("interrupted");
});

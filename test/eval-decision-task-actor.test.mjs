import { expect, it, vi } from "vitest";
import { ACTOR_ACTION_SCHEMA, actorConfiguration } from "../desktop/eval-main/task-actor.mjs";
import { createTaskActor, decisionActorChoices } from "../desktop/eval-main/decision-task-actor.mjs";

const decision = { contractId: "openai-decisions-codex-text-v1", providerId: "openai-test", model: "gpt-6-luna" };
const observation = (extra = {}) => ({ screenshot: "cGl4ZWxz", text: "Visible workspace", availableActions: ACTOR_ACTION_SCHEMA.properties.kind.enum,
  controls: [{ ref: "node-a", role: "button", name: "Explore recommendation" }, { ref: "reply", role: "textarea", name: "Message", canFill: true },
    { ref: "menu", role: "select", name: "Choose region" }], ...extra });
const operation = (kind, ref = "", value = "") => ({ kind, ref, value, reason: "", satisfaction: null, comment: "", endpointStatus: null, remainingWork: "" });
async function actorFixture(choose = () => "click") {
  const requests = [];
  const generator = { decide: vi.fn(async (obs) => ({ action: { ...obs.selectedOperation, value: "A quiet place, please", comment: "Short reply" }, usage: null })),
    observe: vi.fn(async () => ({ comment: "I can see what is being checked", usage: null })), close: vi.fn() };
  const actor = await createTaskActor({ config: actorConfiguration({ decision }), prompt: "PRIVATE BRIEF: prefers quiet places",
    runtime: { textRuntime: { executable: "/isolated/codex" }, decide: async (body, signal) => {
      requests.push(body);
      const wanted = await choose(body, signal);
      if (wanted === "refusal") return { answer: { type: "refusal", name: "action" }, usage: null };
      const offered = body.questions[0].choices.find(item => {
        const parsed = item.description.startsWith("{") ? JSON.parse(item.description) : null;
        return parsed?.kind === wanted || wanted === "watch" && parsed === null;
      });
      return { answer: { type: "choice", name: "action", choice: offered?.value ?? wanted }, usage: { input_tokens: 10 } };
    } }, createTextActor: async ({ runtime }) => { expect(runtime).toEqual({ executable: "/isolated/codex" }); return generator; } });
  return { actor, generator, requests };
}

it("routes an actor without decision settings through its original native implementation", async () => {
  const run = vi.fn(async () => ({ finalResponse: JSON.stringify(operation("click", "node-a")), items: [], usage: null }));
  const actor = await createTaskActor({ config: actorConfiguration(), prompt: "Ordinary user", runtime: { executable: "/isolated/codex", environment: {} },
    createCodex: () => ({ startThread: () => ({ run }) }) });
  try { expect((await actor.decide(observation())).action).toEqual(operation("click", "node-a")); }
  finally { await actor.close(); }
  expect(run).toHaveBeenCalledOnce();
});

it("selects a concrete visible operation, composes only its text, and remembers working and settled observations", async () => {
  let index = 0;
  const f = await actorFixture(() => ["click", "watch", "fill"][index++]);
  try {
    const first = await f.actor.decide(observation());
    expect(first.action).toEqual(operation("click", "node-a"));
    expect(f.generator.decide).not.toHaveBeenCalled();
    const working = await f.actor.observe(observation({ currentUpdate: { revision: 2 }, availableActions: [] }), undefined, { actionSchema: ACTOR_ACTION_SCHEMA });
    expect(working).toMatchObject({ comment: "I can see what is being checked", action: null });
    expect(working.decisionEvidence.selectionSource).toBe("only-available-operation");
    // The singleton watch needed no inference; the next request chooses fill.
    index = 2;
    const result = await f.actor.decide(observation({ text: "Which atmosphere?" }));
    expect(result.action).toMatchObject({ kind: "fill", ref: "reply", value: "A quiet place, please" });
    const state = JSON.parse(f.requests.at(-1).input[0].content[0].text);
    expect(state.history).toHaveLength(2);
    expect(state.history[0].intent).toEqual(first.action);
    expect(state.history[1].comment).toBe(working.comment);
    expect(state.role).toContain("PRIVATE BRIEF");
    expect(result.decisionEvidence).toMatchObject({ ...decision, selected: expect.any(String), requestDigest: expect.stringMatching(/^sha256:/) });
    expect(f.generator.decide.mock.calls[0][0].decisionHistory[0]).not.toHaveProperty("screenshot");
    expect(f.generator.decide.mock.calls[0][2].outputSchema.properties.ref.enum).toEqual(["reply"]);
  } finally { await f.actor.close(); }
  expect(f.generator.close).toHaveBeenCalledOnce();
});

it("offers only observed menu labels and the host's phase-specific authority", () => {
  const schema = structuredClone(ACTOR_ACTION_SCHEMA);
  schema.properties.kind.enum = ["click", "select"];
  const hidden = decisionActorChoices(observation(), schema, true);
  expect(hidden.map(item => item.action?.kind)).not.toContain("select");
  const open = observation();
  open.controls[2] = { ...open.controls[2], options: ["North", "South"], optionObservation: "opened-native-select-accessibility" };
  const offered = decisionActorChoices(open, schema, true);
  expect(offered.filter(item => item.action?.kind === "select").map(item => item.action.value)).toEqual(["North", "South"]);
  expect(offered.some(item => ["finish", "fill", "next_step"].includes(item.action?.kind))).toBe(false);
  expect(offered[0].action).toBe(null);
});

it("generates a working answer only for the selected live input and retains its experience comment", async () => {
  const f = await actorFixture(() => "fill");
  const schema = structuredClone(ACTOR_ACTION_SCHEMA);
  schema.properties.kind.enum = ["click", "fill", "select"];
  try {
    const result = await f.actor.observe(observation({ currentUpdate: { revision: 1 }, availableActions: ["click", "fill", "select"] }), undefined, { actionSchema: schema });
    expect(result).toMatchObject({ comment: "Short reply", action: { kind: "fill", ref: "reply", value: "A quiet place, please" } });
    expect(f.generator.decide.mock.calls[0][2].outputSchema.properties.kind.enum).toEqual(["fill"]);
    expect(f.generator.observe).not.toHaveBeenCalled();
  } finally { await f.actor.close(); }
});

it.each(["forged-choice", "refusal"])("rejects %s without asking the text actor to invent a replacement", async choice => {
  const f = await actorFixture(() => choice);
  try { await expect(f.actor.decide(observation())).rejects.toMatchObject({ code: "actor_invalid_action" }); }
  finally { await f.actor.close(); }
  expect(f.generator.decide).not.toHaveBeenCalled();
});

it("rejects generated target substitution and cancels before retaining a queued decision", async () => {
  const f = await actorFixture(() => "fill");
  f.generator.decide.mockResolvedValueOnce({ action: operation("fill", "other-ref", "text"), usage: null });
  try { await expect(f.actor.decide(observation())).rejects.toMatchObject({ code: "actor_invalid_action" }); }
  finally { await f.actor.close(); }
  const controller = new AbortController();
  const cancelled = await actorFixture((_body, signal) => { controller.abort(); signal.throwIfAborted(); });
  try { await expect(cancelled.actor.decide(observation(), controller.signal)).rejects.toMatchObject({ name: "AbortError" }); }
  finally { await cancelled.actor.close(); }
  expect(cancelled.generator.decide).not.toHaveBeenCalled();
});

it("preserves the Decisions request limits with explicit screenshot omissions and no candidate truncation", async () => {
  const f = await actorFixture();
  try {
    for (let index = 0; index < 130; index++) await f.actor.observe(observation({ availableActions: [] }), undefined, { actionSchema: ACTOR_ACTION_SCHEMA });
    const result = await f.actor.decide(observation());
    expect(f.requests[0].input[0].content.filter(item => item.type === "input_image")).toHaveLength(128);
    expect(result.decisionEvidence.omittedEarlierScreenshots).toBe(3);
    await expect(f.actor.decide(observation({ controls: Array.from({ length: 256 }, (_, index) => ({ ref: `ref-${index}`, role: "button", name: "Item" })) })))
      .rejects.toMatchObject({ code: "actor_decision_limit" });
  } finally { await f.actor.close(); }
});


it("offers fill only for observed DOM capability, independently of role", () => {
  const controls = [
    { ref: "checkbox", role: "input", inputType: "checkbox", canFill: false, name: "Check" },
    { ref: "radio", role: "textbox", inputType: "radio", canFill: false, name: "Radio" },
    { ref: "readonly", role: "input", inputType: "text", canFill: false, name: "Read only" },
    { ref: "unknown", role: "textbox", name: "Unverified" },
    { ref: "text", role: "input", inputType: "text", canFill: true, name: "Text" },
    { ref: "range", role: "input", inputType: "range", canFill: true, name: "Range" },
  ];
  for (const working of [false, true]) {
    const offered = decisionActorChoices(observation({ controls }), ACTOR_ACTION_SCHEMA, working);
    expect(offered.filter(choice => choice.action?.kind === "fill").map(choice => choice.action.ref)).toEqual(["text", "range"]);
    expect(offered.some(choice => choice.action?.kind === "click" && choice.action.ref === "checkbox")).toBe(true);
  }
});

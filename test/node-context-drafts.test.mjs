import { describe, expect, it, vi } from "vitest";
import { createNodeContextDraftController } from "../desktop/renderer/src/node-context-drafts.js";

const target = { nodeId: 7, sourceInteractionNodeId: 3, sourceLayerId: 5 };
const targetNode = {
  id: 7,
  kind: "concept",
  icon: "list",
  title: "Incoming queue",
  detail: "Tasks wait here.",
  state: "accepted",
};

describe("node-context draft renderer state", () => {
  it("lists, guards, and detaches draft observations per thread", async () => {
    const scenarios = [
      ["lists no drafts for an empty thread", async () => {

    const controller = createNodeContextDraftController({ api: {} });

    expect(controller.draftsForThread("alpha")).toEqual([]);
  
      }],
      ["lists many restored drafts in their stable server order", async () => {

    const drafts = Array.from({ length: 12 }, (_, index) => ({
      id: `draft-${index}`,
      threadId: 1,
      target: { ...target, nodeId: 100 + index },
      targetNode: { ...targetNode, id: 100 + index, title: `Node ${index}` },
      text: `Draft ${index}`,
      revision: index + 1,
    }));
    const api = { list: vi.fn(async () => ({ drafts })) };
    const controller = createNodeContextDraftController({ api });

    await controller.load("alpha");

    expect(controller.draftsForThread("alpha").map((draft) => draft.id)).toEqual(
      drafts.map((draft) => draft.id),
    );
  
      }],
      ["includes local unsaved drafts in controller order", async () => {

    let nextId = 0;
    const controller = createNodeContextDraftController({
      api: {},
      createId: () => `local-${nextId++}`,
      schedule: () => 1,
      cancel: vi.fn(),
    });
    const secondTarget = { ...target, nodeId: 8 };
    const secondNode = { ...targetNode, id: 8, title: "Second queue" };
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "First local note");
    controller.open("alpha", secondTarget, secondNode);

    expect(controller.draftsForThread("alpha")).toMatchObject([
      { id: "local-0", text: "First local note", status: "unsaved" },
      { id: "local-1", text: "", status: "unsaved" },
    ]);
  
      }],
      ["returns detached immutable observations that cannot mutate controller drafts", async () => {

    const controller = createNodeContextDraftController({
      api: {},
      createId: () => "local-id",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Keep this note");

    const observed = controller.draftsForThread("alpha");
    expect(() => observed.push({})).toThrow();
    expect(() => { observed[0].text = "mutated"; }).toThrow();
    expect(() => { observed[0].target.nodeId = 999; }).toThrow();
    expect(() => { observed[0].targetNode.title = "Mutated title"; }).toThrow();

    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      text: "Keep this note",
      target: { nodeId: 7 },
      targetNode: { title: "Incoming queue" },
    });
    expect(controller.draftsForThread("alpha")[0]).toMatchObject({
      text: "Keep this note",
      target: { nodeId: 7 },
      targetNode: { title: "Incoming queue" },
    });
  
      }],
      ["does not retarget a draft between repeated node occurrences", async () => {

    const controller = createNodeContextDraftController({
      api: {},
      createId: () => "local-id",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);

    expect(() => controller.open(
      "alpha",
      { ...target, sourceInteractionNodeId: 9, sourceLayerId: 12 },
      targetNode,
    )).toThrow("existing annotation draft");
    expect(controller.draftForNode("alpha", 7)?.target).toEqual(target);
  
      }],
      ["does not open a second occurrence after the node is confirmed elsewhere", async () => {

    const confirmation = {
      draftId: "confirmed-a",
      target,
      targetNode,
      annotation: "FIFO",
      draftRevision: 1,
      confirmationRevision: 1,
    };
    const controller = createNodeContextDraftController({
      api: { list: vi.fn(async () => ({ drafts: [], confirmations: [confirmation] })) },
      createId: () => "local-id",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    await controller.load("alpha");

    expect(() => controller.open(
      "alpha",
      { ...target, sourceInteractionNodeId: 9, sourceLayerId: 12 },
      targetNode,
    )).toThrow("already attached from another occurrence");
    expect(controller.draftsForThread("alpha")).toEqual([]);
  
      }],
      ["restores independent server drafts when navigating between threads", async () => {

    const api = {
      list: vi.fn(async (threadId) => ({
        drafts: threadId === "alpha"
          ? [{ id: "draft-a", threadId: 1, target, targetNode, text: "FIFO", revision: 2 }]
          : [{ id: "draft-b", threadId: 2, target: { ...target, nodeId: 8 }, targetNode: { ...targetNode, id: 8 }, text: "LIFO", revision: 1 }],
      })),
      save: vi.fn(),
    };
    const controller = createNodeContextDraftController({ api });

    await controller.load("alpha");
    expect(controller.draftForNode("alpha", 7)?.text).toBe("FIFO");
    await controller.load("beta");
    expect(controller.draftForNode("beta", 8)?.text).toBe("LIFO");
    expect(controller.draftForNode("alpha", 7)?.id).toBe("draft-a");
  
      }],
    ];
    expect(scenarios, "observation scenario inventory").toHaveLength(7);
    for (const [label, scenario] of scenarios) {
      await expect.soft(
        scenario().catch((error) => {
          throw new Error(`scenario "${label}" failed`, { cause: error });
        }),
      ).resolves.toBeUndefined();
    }
  }, 15_000);

  it("walks the autosave lifecycle from failure through serialized races and conflict rebase", async () => {
    const scenarios = [
      ["reports autosave failure without losing text or claiming it was saved", async () => {

    let runScheduled;
    const api = { list: vi.fn(), save: vi.fn(async () => { throw new Error("disk full"); }) };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "stable-draft",
      schedule: (callback) => { runScheduled = callback; return 1; },
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Keep this note");
    expect(controller.draftForNode("alpha", 7)?.status).toBe("unsaved");

    await runScheduled();

    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "stable-draft",
      text: "Keep this note",
      status: "error",
      error: "disk full",
      revision: null,
    });
  
      }],
      ["keeps a newer edit unsaved when an older autosave response arrives", async () => {

    let resolveSave;
    const api = {
      list: vi.fn(),
      save: vi.fn(() => new Promise((resolve) => { resolveSave = resolve; })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    const first = controller.flush("alpha", 7);
    controller.update("alpha", 7, "newer text");
    resolveSave({ id: "draft-a", threadId: 1, target, targetNode, text: "", revision: 1 });
    await first;

    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      text: "newer text",
      revision: 1,
      status: "unsaved",
    });
  
      }],
      ["serializes overlapping autosaves onto the returned revision", async () => {

    let resolveFirst;
    const api = {
      list: vi.fn(),
      save: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 2 })),
    };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "draft-a",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "first");
    const first = controller.flush("alpha", 7);
    controller.update("alpha", 7, "second");
    const queued = controller.flush("alpha", 7);
    resolveFirst({ id: "draft-a", threadId: 1, target, targetNode, text: "first", revision: 1 });
    await Promise.all([first, queued]);

    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls[1][1]).toMatchObject({ text: "second", revision: 1 });
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      text: "second",
      revision: 2,
      status: "saved",
    });
  
      }],
      ["rebases a revision conflict without losing local text", async () => {

    const conflict = Object.assign(new Error("revision conflict"), {
      code: "context_draft_revision_conflict",
    });
    const api = {
      list: vi.fn(async () => ({
        drafts: [{ id: "draft-a", threadId: 1, target, targetNode, text: "remote", revision: 2 }],
      })),
      save: vi.fn()
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 1 }))
        .mockRejectedValueOnce(conflict)
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 3 })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "initial text");
    await controller.flush("alpha", 7);
    controller.update("alpha", 7, "local text");

    await controller.flush("alpha", 7);

    expect(api.list).toHaveBeenCalledWith("alpha");
    expect(api.save).toHaveBeenCalledTimes(3);
    expect(api.save.mock.calls[2][1]).toMatchObject({
      id: "draft-a",
      revision: 2,
      text: "local text",
    });
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      revision: 3,
      text: "local text",
      status: "saved",
    });
  
      }],
    ];
    expect(scenarios, "autosave scenario inventory").toHaveLength(4);
    for (const [label, scenario] of scenarios) {
      await expect.soft(
        scenario().catch((error) => {
          throw new Error(`scenario "${label}" failed`, { cause: error });
        }),
      ).resolves.toBeUndefined();
    }
  }, 15_000);

  it("gates overridden sends on every draft reaching durable storage", async () => {
    const scenarios = [
      ["persists every local draft before an overridden send can continue", async () => {

    const api = {
      save: vi.fn(async (_threadId, draft) => ({
        ...draft,
        revision: draft.target.nodeId,
        createdAt: "2026-08-28T00:00:00Z",
        updatedAt: "2026-08-28T00:00:00Z",
      })),
    };
    let nextId = 0;
    const controller = createNodeContextDraftController({
      api,
      createId: () => `draft-${nextId++}`,
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "First note");
    controller.open(
      "alpha",
      { ...target, nodeId: 8 },
      { ...targetNode, id: 8, title: "Second queue" },
    );
    controller.update("alpha", 8, "Second note");

    await expect(controller.persistAll("alpha")).resolves.toMatchObject([
      { text: "First note", revision: 7, status: "saved" },
      { text: "Second note", revision: 8, status: "saved" },
    ]);
    expect(api.save).toHaveBeenCalledTimes(2);
  
      }],
      ["does not rewrite drafts that are already durably saved", async () => {

    const api = {
      list: vi.fn(async () => ({
        drafts: [{
          id: "saved-draft",
          threadId: "alpha",
          target,
          targetNode,
          text: "Already durable",
          revision: 4,
        }],
      })),
      save: vi.fn(),
    };
    const controller = createNodeContextDraftController({ api });
    await controller.load("alpha");

    await expect(controller.persistAll("alpha")).resolves.toMatchObject([{
      id: "saved-draft",
      revision: 4,
      status: "saved",
    }]);
    expect(api.save).not.toHaveBeenCalled();
  
      }],
      ["blocks an overridden send while any draft still cannot be persisted", async () => {

    const api = { save: vi.fn(async () => { throw new Error("disk full"); }) };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "stable-draft",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Keep this note");

    await expect(controller.persistAll("alpha")).rejects.toThrow(
      "1 annotation draft is not saved yet",
    );
    expect(controller.draftsForThread("alpha")).toMatchObject([{
      id: "stable-draft",
      text: "Keep this note",
      status: "error",
      revision: null,
    }]);
  
      }],
    ];
    expect(scenarios, "send-gate scenario inventory").toHaveLength(3);
    for (const [label, scenario] of scenarios) {
      await expect.soft(
        scenario().catch((error) => {
          throw new Error(`scenario "${label}" failed`, { cause: error });
        }),
      ).resolves.toBeUndefined();
    }
  }, 15_000);

  it("hydrates restorations without clobbering racing local work", async () => {
    const scenarios = [
      ["hydrates pending confirmations and cannot resurrect a consumed stale response", async () => {

    const confirmation = {
      draftId: "draft-confirmed",
      threadId: 1,
      target,
      targetNode,
      annotation: "FIFO",
      draftRevision: 2,
    };
    const api = {
      list: vi.fn(async () => ({ drafts: [], confirmations: [confirmation] })),
      save: vi.fn(),
    };
    const controller = createNodeContextDraftController({ api });

    await controller.load("alpha");
    expect(controller.confirmationsForThread("alpha")).toEqual([confirmation]);
    controller.consumeConfirmations("alpha", [confirmation.draftId]);
    await controller.load("alpha");
    expect(controller.confirmationsForThread("alpha")).toEqual([]);
    controller.allowConfirmationRestoration("alpha");
    await controller.load("alpha");
    expect(controller.confirmationsForThread("alpha")).toEqual([confirmation]);
  
      }],
      ["treats an absent authoritative confirmation as remotely consumed", async () => {

    const confirmation = {
      draftId: "draft-confirmed",
      threadId: 1,
      target,
      targetNode,
      annotation: "FIFO",
      draftRevision: 2,
      confirmationRevision: 1,
    };
    const api = {
      list: vi.fn()
        .mockResolvedValueOnce({ drafts: [], confirmations: [confirmation] })
        .mockResolvedValueOnce({ drafts: [], confirmations: [] }),
      save: vi.fn(),
    };
    const controller = createNodeContextDraftController({ api });
    await controller.load("alpha");
    await controller.load("alpha");
    expect(controller.confirmationsForThread("alpha")).toEqual([]);
  
      }],
      ["does not replace a confirmation advanced by a load while its update is pending", async () => {

    let resolveUpdate;
    const confirmation = {
      draftId: "draft-confirmed",
      threadId: 1,
      target,
      targetNode,
      annotation: "FIFO",
      draftRevision: 2,
      confirmationRevision: 1,
    };
    const advanced = {
      ...confirmation,
      annotation: "Authoritative edit",
      confirmationRevision: 2,
    };
    const api = {
      list: vi.fn()
        .mockResolvedValueOnce({ drafts: [], confirmations: [confirmation] })
        .mockResolvedValueOnce({ drafts: [], confirmations: [advanced] }),
      updateConfirmation: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })),
    };
    const controller = createNodeContextDraftController({ api });
    await controller.load("alpha");

    const updating = controller.updateConfirmation("alpha", confirmation.draftId, "Local edit");
    await controller.load("alpha");
    resolveUpdate({
      ...confirmation,
      annotation: "Local edit",
      confirmationRevision: 2,
    });

    await expect(updating).resolves.toBeNull();
    expect(controller.confirmationsForThread("alpha")).toEqual([advanced]);
  
      }],
      ["does not resurrect a confirmation consumed while its update is pending", async () => {

    let resolveUpdate;
    const confirmation = {
      draftId: "draft-confirmed",
      threadId: 1,
      target,
      targetNode,
      annotation: "FIFO",
      draftRevision: 2,
      confirmationRevision: 1,
    };
    const api = {
      list: vi.fn(async () => ({ drafts: [], confirmations: [confirmation] })),
      updateConfirmation: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })),
    };
    const controller = createNodeContextDraftController({ api });
    await controller.load("alpha");

    const updating = controller.updateConfirmation("alpha", confirmation.draftId, "Local edit");
    controller.consumeConfirmations("alpha", [confirmation.draftId]);
    resolveUpdate({
      ...confirmation,
      annotation: "Local edit",
      confirmationRevision: 2,
    });

    await expect(updating).resolves.toBeNull();
    expect(controller.confirmationsForThread("alpha")).toEqual([]);
  
      }],
      ["does not overwrite a local edit when restart restoration finishes late", async () => {

    let resolveList;
    const api = {
      list: vi.fn(() => new Promise((resolve) => { resolveList = resolve; })),
      save: vi.fn(),
    };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "local-id",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    const loading = controller.load("alpha");
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "typed while loading");
    resolveList({
      drafts: [{ id: "server-id", threadId: 1, target, targetNode, text: "older", revision: 4 }],
    });
    await loading;

    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "server-id",
      text: "typed while loading",
      revision: 4,
      status: "unsaved",
    });
  
      }],
      ["replaces an untouched editor opened while restart restoration is loading", async () => {

    let resolveList;
    const api = {
      list: vi.fn(() => new Promise((resolve) => { resolveList = resolve; })),
      save: vi.fn(),
    };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "local-id",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    const loading = controller.load("alpha");
    controller.open("alpha", target, targetNode);
    resolveList({
      drafts: [{ id: "server-id", threadId: 1, target, targetNode, text: "restored", revision: 4 }],
    });
    await loading;

    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "server-id",
      text: "restored",
      revision: 4,
      status: "saved",
    });
  
      }],
      ["does not overwrite a second draft that starts saving while hydration waits", async () => {

    let resolveFirstSave;
    let resolveSecondSave;
    const secondTarget = { ...target, nodeId: 8 };
    const secondNode = { ...targetNode, id: 8, title: "Second queue" };
    const api = {
      list: vi.fn(async () => ({ drafts: [
        { id: "draft-a", threadId: 1, target, targetNode, text: "server first", revision: 4 },
        { id: "draft-b", threadId: 1, target: secondTarget, targetNode: secondNode, text: "server second", revision: 4 },
      ] })),
      save: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstSave = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondSave = resolve; })),
    };
    let id = 0;
    const controller = createNodeContextDraftController({
      api,
      createId: () => `draft-${id++ === 0 ? "a" : "b"}`,
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.open("alpha", secondTarget, secondNode);
    controller.update("alpha", 7, "local first");
    const firstSave = controller.flush("alpha", 7);
    const loading = controller.load("alpha");
    await Promise.resolve();
    controller.update("alpha", 8, "local second");
    const secondSave = controller.flush("alpha", 8);
    resolveFirstSave({ id: "draft-a", threadId: 1, target, targetNode, text: "local first", revision: 5 });
    await firstSave;
    resolveSecondSave({ id: "draft-b", threadId: 1, target: secondTarget, targetNode: secondNode, text: "local second", revision: 5 });
    await Promise.all([secondSave, loading]);

    expect(controller.draftForNode("alpha", 8)).toMatchObject({
      id: "draft-b",
      text: "local second",
      revision: 5,
      status: "saved",
    });
  
      }],
      ["reconciles an in-flight local identity with a restored server draft", async () => {

    let resolveList;
    let rejectLocalSave;
    const scheduled = [];
    const targetConflict = Object.assign(new Error("target conflict"), {
      code: "context_draft_target_conflict",
    });
    const api = {
      list: vi.fn(() => new Promise((resolve) => { resolveList = resolve; })),
      save: vi.fn()
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLocalSave = reject; }))
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 5 })),
    };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "local-id",
      schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
      cancel: vi.fn(),
    });
    const loading = controller.load("alpha");
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "local text");
    const localSave = controller.flush("alpha", 7);
    resolveList({
      drafts: [{ id: "server-id", threadId: 1, target, targetNode, text: "remote", revision: 4 }],
    });
    rejectLocalSave(targetConflict);

    await localSave;
    await loading;
    await scheduled.at(-1)();

    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls[1][1]).toMatchObject({
      id: "server-id",
      revision: 4,
      text: "local text",
    });
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "server-id",
      revision: 5,
      text: "local text",
      status: "saved",
    });
  
      }],
    ];
    expect(scenarios, "hydration scenario inventory").toHaveLength(8);
    for (const [label, scenario] of scenarios) {
      await expect.soft(
        scenario().catch((error) => {
          throw new Error(`scenario "${label}" failed`, { cause: error });
        }),
      ).resolves.toBeUndefined();
    }
  }, 15_000);

  it("walks the confirmation lifecycle through coalescing, staleness, and replacement guards", async () => {
    const scenarios = [
      ["coalesces concurrent confirms into one confirmation request", async () => {

    let resolveConfirm;
    const api = {
      list: vi.fn(),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      confirm: vi.fn(() => new Promise((resolve) => { resolveConfirm = resolve; })),
    };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "draft-a",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "FIFO");
    await controller.flush("alpha", 7);

    const first = controller.confirm("alpha", 7);
    const duplicate = controller.confirm("alpha", 7);
    resolveConfirm({ draftId: "draft-a", target, targetNode, annotation: "FIFO" });

    await expect(first).resolves.toMatchObject({ draftId: "draft-a" });
    await expect(duplicate).resolves.toBeNull();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  
      }],
      ["coalesces concurrent confirms while the initial save is pending", async () => {

    let resolveSave;
    let resolveConfirm;
    const api = {
      list: vi.fn(),
      save: vi.fn(() => new Promise((resolve) => { resolveSave = resolve; })),
      confirm: vi.fn(() => new Promise((resolve) => { resolveConfirm = resolve; })),
    };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "draft-a",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "FIFO");

    const first = controller.confirm("alpha", 7);
    const duplicate = controller.confirm("alpha", 7);
    resolveSave({ id: "draft-a", threadId: 1, target, targetNode, text: "FIFO", revision: 1 });
    await vi.waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1));
    resolveConfirm({ draftId: "draft-a", target, targetNode, annotation: "FIFO" });

    await expect(first).resolves.toMatchObject({ draftId: "draft-a" });
    await expect(duplicate).resolves.toBeNull();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  
      }],
      ["rejects edits while confirmation is pending", async () => {

    let resolveConfirm;
    const api = {
      list: vi.fn(),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      confirm: vi.fn(() => new Promise((resolve) => { resolveConfirm = resolve; })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "FIFO");
    await controller.flush("alpha", 7);

    const confirmation = controller.confirm("alpha", 7);
    expect(controller.update("alpha", 7, "newer text")).toBeNull();
    expect(controller.draftForNode("alpha", 7)?.text).toBe("FIFO");
    resolveConfirm({ draftId: "draft-a", target, targetNode, annotation: "FIFO" });

    await confirmation;
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  
      }],
      ["does not retarget confirmation while its initial save settles", async () => {

    let resolveSave;
    let controller;
    let replacementInstalled = false;
    const api = {
      save: vi.fn(() => new Promise((resolve) => { resolveSave = resolve; })),
      confirm: vi.fn(async () => ({
        draftId: "draft-newer", target, targetNode, annotation: "Confirm me",
      })),
    };
    controller = createNodeContextDraftController({
      api,
      createId: () => "draft-a",
      onChange() {
        const draft = controller?.draftForNode("alpha", 7);
        if (!replacementInstalled
          && api.save.mock.calls.length === 1
          && draft?.id === "draft-a"
          && draft.status === "saved") {
          replacementInstalled = true;
          const replacement = {
            ...draft,
            id: "draft-newer",
            revision: 2,
            operation: { kind: "idle" },
          };
          const originalDraftForNode = controller.draftForNode.bind(controller);
          controller.draftForNode = (threadId, nodeId) => (
            String(threadId) === "alpha" && String(nodeId) === "7"
              ? replacement
              : originalDraftForNode(threadId, nodeId)
          );
        }
      },
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Confirm me");

    const confirming = controller.confirm("alpha", 7);
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    resolveSave({
      id: "draft-a", threadId: "alpha", target, targetNode, text: "Confirm me", revision: 1,
    });

    await expect(confirming).resolves.toBeNull();
    expect(api.confirm).not.toHaveBeenCalled();
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "draft-newer",
      operation: { kind: "idle" },
    });
  
      }],
      ["does not reinstall a confirmation older than an authoritative reload", async () => {

    let resolveConfirm;
    const api = {
      list: vi.fn(async () => ({
        drafts: [{
          id: "draft-newer",
          threadId: "alpha",
          target,
          targetNode,
          text: "Newer renderer work",
          revision: 2,
        }],
        confirmations: [],
      })),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      confirm: vi.fn(() => new Promise((resolve) => { resolveConfirm = resolve; })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "FIFO");
    await controller.flush("alpha", 7);

    const confirming = controller.confirm("alpha", 7);
    await controller.load("alpha");
    resolveConfirm({ draftId: "draft-a", target, targetNode, annotation: "FIFO" });
    await expect(confirming).resolves.toBeNull();

    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "draft-newer",
      text: "Newer renderer work",
      operation: { kind: "idle" },
    });
    expect(controller.confirmationsForThread("alpha")).toEqual([]);
  
      }],
      ["does not apply a successful confirmation to a replacement draft", async () => {

    let resolveList;
    let resolveConfirm;
    const api = {
      list: vi.fn(() => new Promise((resolve) => { resolveList = resolve; })),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      confirm: vi.fn(() => new Promise((resolve) => { resolveConfirm = resolve; })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Confirm me");
    await controller.flush("alpha", 7);

    const loading = controller.load("alpha");
    const confirming = controller.confirm("alpha", 7);
    resolveList({
      drafts: [{
        id: "draft-newer",
        threadId: "alpha",
        target,
        targetNode,
        text: "Newer renderer work",
        revision: 2,
      }],
      confirmations: [],
    });
    await loading;
    resolveConfirm({
      draftId: "draft-a", target, targetNode, annotation: "Confirm me",
    });

    await expect(confirming).resolves.toBeNull();
    expect(controller.confirmationsForThread("alpha")).toEqual([]);
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "draft-newer",
      text: "Newer renderer work",
      operation: { kind: "idle" },
    });
  
      }],
      ["does not reconcile a stale confirmation conflict through a replacement draft", async () => {

    let rejectConfirm;
    const conflict = Object.assign(new Error("stale confirmation"), {
      code: "context_draft_revision_conflict",
    });
    const api = {
      list: vi.fn(async () => ({
        drafts: [{
          id: "draft-newer",
          threadId: "alpha",
          target,
          targetNode,
          text: "Newer renderer work",
          revision: 2,
        }],
        confirmations: [],
      })),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      confirm: vi.fn(() => new Promise((_resolve, reject) => { rejectConfirm = reject; })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Confirm me");
    await controller.flush("alpha", 7);

    const confirming = controller.confirm("alpha", 7);
    await controller.load("alpha");
    rejectConfirm(conflict);
    await expect(confirming).rejects.toBe(conflict);

    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "draft-newer",
      text: "Newer renderer work",
      operation: { kind: "idle" },
    });
  
      }],
      ["reloads, preserves local text, and retries a stale confirmation once", async () => {

    const conflict = Object.assign(new Error("revision conflict"), {
      code: "context_draft_revision_conflict",
    });
    const api = {
      list: vi.fn(async () => ({
        drafts: [{ id: "draft-a", threadId: 1, target, targetNode, text: "remote", revision: 2 }],
      })),
      save: vi.fn()
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 1 }))
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 3 })),
      confirm: vi.fn()
        .mockRejectedValueOnce(conflict)
        .mockImplementationOnce(async () => ({
          draftId: "draft-a", target, targetNode, annotation: "local text",
        })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "local text");
    await controller.flush("alpha", 7);

    await expect(controller.confirm("alpha", 7)).resolves.toMatchObject({ draftId: "draft-a" });

    expect(api.confirm).toHaveBeenCalledTimes(2);
    expect(api.confirm.mock.calls[0][1].revision).toBe(1);
    expect(api.save.mock.calls[1][1]).toMatchObject({ revision: 2, text: "local text" });
    expect(api.confirm.mock.calls[1][1].revision).toBe(3);
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  
      }],
      ["releases confirmation ownership when conflict reconciliation cannot reload", async () => {

    const conflict = Object.assign(new Error("stale confirmation"), {
      code: "context_draft_revision_conflict",
    });
    const loadError = new Error("reload unavailable");
    const api = {
      list: vi.fn(async () => { throw loadError; }),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      confirm: vi.fn(async () => { throw conflict; }),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Keep this work");
    await controller.flush("alpha", 7);

    await expect(controller.confirm("alpha", 7)).rejects.toBe(loadError);

    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "draft-a",
      text: "Keep this work",
      operation: { kind: "idle" },
    });
  
      }],
      ["does not confirm a replacement installed while reconciliation saves", async () => {

    let controller;
    let replacementStarted = false;
    const conflict = Object.assign(new Error("stale confirmation"), {
      code: "context_draft_revision_conflict",
    });
    const api = {
      list: vi.fn()
        .mockResolvedValueOnce({
          drafts: [{ id: "draft-a", threadId: "alpha", target, targetNode, text: "Remote A", revision: 2 }],
          confirmations: [],
        }),
      save: vi.fn()
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 1 }))
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 3 })),
      confirm: vi.fn().mockRejectedValueOnce(conflict),
    };
    controller = createNodeContextDraftController({
      api,
      createId: () => "draft-a",
      onChange() {
        const draft = controller?.draftForNode("alpha", 7);
        if (!replacementStarted
          && api.save.mock.calls.length === 2
          && draft?.id === "draft-a"
          && draft.status === "saved") {
          replacementStarted = true;
          const replacement = {
            ...draft,
            id: "draft-b",
            revision: 4,
            operation: { kind: "idle" },
          };
          const originalDraftForNode = controller.draftForNode.bind(controller);
          controller.draftForNode = (threadId, nodeId) => (
            String(threadId) === "alpha" && String(nodeId) === "7"
              ? replacement
              : originalDraftForNode(threadId, nodeId)
          );
        }
      },
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Local A");
    await controller.flush("alpha", 7);

    const confirming = controller.confirm("alpha", 7);
    await expect(confirming).rejects.toBe(conflict);

    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "draft-b",
      text: "Local A",
      operation: { kind: "idle" },
    });
  
      }],
      ["keeps confirmed annotations coherent when a multi-dismiss partially fails", async () => {

    const confirmations = ["a", "b"].map((draftId) => ({
      draftId,
      threadId: 1,
      target,
      targetNode,
      annotation: draftId.toUpperCase(),
      draftRevision: 2,
      confirmationRevision: 1,
    }));
    const changed = vi.fn();
    const api = {
      list: vi.fn(async () => ({ drafts: [], confirmations })),
      dismissConfirmation: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("revision conflict")),
    };
    const controller = createNodeContextDraftController({ api, onChange: changed });
    await controller.load("alpha");

    await expect(controller.dismissConfirmations("alpha", ["a", "b"]))
      .rejects.toThrow("revision conflict");

    expect(controller.confirmationsForThread("alpha").map((item) => item.draftId)).toEqual(["b"]);
    expect(changed).toHaveBeenCalledTimes(2);
  
      }],
    ];
    expect(scenarios, "confirmation scenario inventory").toHaveLength(11);
    for (const [label, scenario] of scenarios) {
      await expect.soft(
        scenario().catch((error) => {
          throw new Error(`scenario "${label}" failed`, { cause: error });
        }),
      ).resolves.toBeUndefined();
    }
  }, 15_000);

  it("walks the discard lifecycle through ordering, staleness, and replacement guards", async () => {
    const scenarios = [
      ["resolves an uncertain first save before discarding the durable draft", async () => {

    const api = {
      list: vi.fn(),
      save: vi.fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      discard: vi.fn(async () => null),
    };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "draft-a",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "FIFO");
    await controller.flush("alpha", 7);
    expect(controller.draftForNode("alpha", 7)?.status).toBe("error");

    await controller.discard("alpha", 7);

    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.discard).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ id: "draft-a", revision: 1 }),
    );
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  
      }],
      ["waits for an in-flight successful save before discarding", async () => {

    let resolveSave;
    const api = {
      list: vi.fn(),
      save: vi.fn(() => new Promise((resolve) => { resolveSave = resolve; })),
      discard: vi.fn(async () => null),
    };
    const controller = createNodeContextDraftController({
      api,
      createId: () => "draft-a",
      schedule: () => 1,
      cancel: vi.fn(),
    });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "FIFO");
    const save = controller.flush("alpha", 7);

    const discard = controller.discard("alpha", 7);
    expect(api.discard).not.toHaveBeenCalled();
    resolveSave({ id: "draft-a", threadId: 1, target, targetNode, text: "FIFO", revision: 1 });
    await save;
    await discard;

    expect(api.discard).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ id: "draft-a", revision: 1 }),
    );
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  
      }],
      ["rejects edits while discard is pending", async () => {

    let resolveDiscard;
    const api = {
      list: vi.fn(),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      discard: vi.fn(() => new Promise((resolve) => { resolveDiscard = resolve; })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "FIFO");
    await controller.flush("alpha", 7);

    const discard = controller.discard("alpha", 7);
    expect(controller.update("alpha", 7, "newer text")).toBeNull();
    expect(controller.draftForNode("alpha", 7)?.text).toBe("FIFO");
    resolveDiscard(null);

    await discard;
    expect(api.discard).toHaveBeenCalledTimes(1);
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  
      }],
      ["does not retarget or erase a newer draft while an older discard settles", async () => {

    let resolveDiscard;
    const api = {
      list: vi.fn(async () => ({
        drafts: [{
          id: "draft-newer",
          threadId: "alpha",
          target,
          targetNode,
          text: "Newer renderer work",
          revision: 2,
        }],
        confirmations: [],
      })),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      discard: vi.fn(() => new Promise((resolve) => { resolveDiscard = resolve; })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Discard me");
    await controller.flush("alpha", 7);

    const discarding = controller.discard("alpha", 7);
    await controller.load("alpha");
    resolveDiscard();
    await discarding;

    expect(api.discard).toHaveBeenCalledTimes(1);
    expect(api.discard.mock.calls[0][1].id).toBe("draft-a");
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "draft-newer",
      text: "Newer renderer work",
      operation: { kind: "idle" },
    });
  
      }],
      ["does not reconcile a stale discard conflict through a replacement draft", async () => {

    let rejectDiscard;
    const conflict = Object.assign(new Error("stale discard"), {
      code: "context_draft_revision_conflict",
    });
    const api = {
      list: vi.fn(async () => ({
        drafts: [{
          id: "draft-newer",
          threadId: "alpha",
          target,
          targetNode,
          text: "Newer renderer work",
          revision: 2,
        }],
        confirmations: [],
      })),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      discard: vi.fn(() => new Promise((_resolve, reject) => { rejectDiscard = reject; })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Discard me");
    await controller.flush("alpha", 7);

    const discarding = controller.discard("alpha", 7);
    rejectDiscard(conflict);
    await expect(discarding).rejects.toBe(conflict);

    expect(api.discard).toHaveBeenCalledTimes(1);
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "draft-newer",
      text: "Newer renderer work",
      operation: { kind: "idle" },
    });
  
      }],
      ["releases discard ownership when conflict reconciliation cannot reload", async () => {

    const conflict = Object.assign(new Error("stale discard"), {
      code: "context_draft_revision_conflict",
    });
    const loadError = new Error("reload unavailable");
    const api = {
      list: vi.fn(async () => { throw loadError; }),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      discard: vi.fn(async () => { throw conflict; }),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "Keep this work");
    await controller.flush("alpha", 7);

    await expect(controller.discard("alpha", 7)).rejects.toBe(loadError);

    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      id: "draft-a",
      text: "Keep this work",
      operation: { kind: "idle" },
    });
  
      }],
      ["keeps discard ownership when an older pending save conflicts", async () => {

    const conflict = Object.assign(new Error("revision conflict"), {
      code: "context_draft_revision_conflict",
    });
    let rejectPendingSave;
    let resolveList;
    const api = {
      list: vi.fn(() => new Promise((resolve) => { resolveList = resolve; })),
      save: vi.fn()
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 1 }))
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {
          rejectPendingSave = reject;
        })),
      discard: vi.fn(async () => null),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "saved text");
    await controller.flush("alpha", 7);
    controller.update("alpha", 7, "newer text");
    const save = controller.flush("alpha", 7);

    const discard = controller.discard("alpha", 7);
    rejectPendingSave(conflict);
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    expect(controller.draftForNode("alpha", 7)?.operation.kind).toBe("discarding");
    expect(controller.update("alpha", 7, "racing edit")).toBeNull();
    resolveList({
      drafts: [{ id: "draft-a", threadId: 1, target, targetNode, text: "remote", revision: 2 }],
    });

    await Promise.all([save, discard]);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.discard).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ revision: 2 }),
    );
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  
      }],
      ["reloads and retries a stale discard once with the current revision", async () => {

    const conflict = Object.assign(new Error("revision conflict"), {
      code: "context_draft_revision_conflict",
    });
    const api = {
      list: vi.fn(async () => ({
        drafts: [{ id: "draft-a", threadId: 1, target, targetNode, text: "local text", revision: 2 }],
      })),
      save: vi.fn(async (_threadId, draft) => ({ ...draft, revision: 1 })),
      discard: vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(null),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "local text");
    await controller.flush("alpha", 7);

    await expect(controller.discard("alpha", 7)).resolves.toBe(true);

    expect(api.discard).toHaveBeenCalledTimes(2);
    expect(api.discard.mock.calls[0][1].revision).toBe(1);
    expect(api.discard.mock.calls[1][1].revision).toBe(2);
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  
      }],
    ];
    expect(scenarios, "discard scenario inventory").toHaveLength(8);
    for (const [label, scenario] of scenarios) {
      await expect.soft(
        scenario().catch((error) => {
          throw new Error(`scenario "${label}" failed`, { cause: error });
        }),
      ).resolves.toBeUndefined();
    }
  }, 15_000);

});

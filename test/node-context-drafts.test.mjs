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
  it("restores independent server drafts when navigating between threads", async () => {
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
  });

  it("reports autosave failure without losing text or claiming it was saved", async () => {
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
  });

  it("keeps a newer edit unsaved when an older autosave response arrives", async () => {
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
  });

  it("does not overwrite a local edit when restart restoration finishes late", async () => {
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
  });

  it("serializes overlapping autosaves onto the returned revision", async () => {
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
  });

  it("coalesces concurrent confirms into one confirmation request", async () => {
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
  });

  it("rejects edits while confirmation is pending", async () => {
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
  });

  it("coalesces concurrent confirms while the initial save is pending", async () => {
    let resolveSave;
    const api = {
      list: vi.fn(),
      save: vi.fn(() => new Promise((resolve) => { resolveSave = resolve; })),
      confirm: vi.fn(async () => ({ draftId: "draft-a", target, targetNode, annotation: "FIFO" })),
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

    await expect(first).resolves.toMatchObject({ draftId: "draft-a" });
    await expect(duplicate).resolves.toBeNull();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(controller.draftForNode("alpha", 7)).toBeNull();
  });

  it("resolves an uncertain first save before discarding the durable draft", async () => {
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
  });

  it("waits for an in-flight successful save before discarding", async () => {
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
  });

  it("rejects edits while discard is pending", async () => {
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
  });

  it("rebases a revision conflict without losing local text", async () => {
    const conflict = Object.assign(new Error("revision conflict"), {
      code: "context_draft_revision_conflict",
    });
    const api = {
      list: vi.fn(async () => ({
        drafts: [{ id: "draft-a", threadId: 1, target, targetNode, text: "remote", revision: 2 }],
      })),
      save: vi.fn()
        .mockRejectedValueOnce(conflict)
        .mockImplementationOnce(async (_threadId, draft) => ({ ...draft, revision: 3 })),
    };
    const controller = createNodeContextDraftController({ api, createId: () => "draft-a" });
    controller.open("alpha", target, targetNode);
    controller.update("alpha", 7, "local text");

    await controller.flush("alpha", 7);

    expect(api.list).toHaveBeenCalledWith("alpha");
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls[1][1]).toMatchObject({
      id: "draft-a",
      revision: 2,
      text: "local text",
    });
    expect(controller.draftForNode("alpha", 7)).toMatchObject({
      revision: 3,
      text: "local text",
      status: "saved",
    });
  });

  it("reconciles an in-flight local identity with a restored server draft", async () => {
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
  });
});

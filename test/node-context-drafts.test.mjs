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
});

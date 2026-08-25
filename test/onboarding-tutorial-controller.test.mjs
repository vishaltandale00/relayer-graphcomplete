import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createOnboardingTutorialController,
} from "../desktop/renderer/src/onboarding-tutorial.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakeClassList(element, initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : force;
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
    values: () => [...values],
    replace(valuesToUse) {
      values.clear();
      valuesToUse.forEach((name) => values.add(name));
    },
    owner: element,
  };
}

class FakeElement {
  constructor({ rect = { left: 20, top: 20, width: 100, height: 30 } } = {}) {
    this.attributes = new Map();
    this.childrenBySelector = new Map();
    this.classList = fakeClassList(this);
    this.focus = vi.fn();
    this.hidden = false;
    this.isConnected = true;
    this.onclick = null;
    this.rect = rect;
    this.style = {};
    this.textContent = "";
  }

  set className(value) {
    this.classList.replace(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return this.classList.values().join(" ");
  }

  set innerHTML(_value) {
    const heading = new FakeElement();
    const paragraph = new FakeElement();
    const skip = new FakeElement();
    skip.textContent = "Skip tutorial";
    skip.className = "tutorial-skip";
    const done = new FakeElement();
    done.textContent = "Done";
    done.className = "tutorial-done hidden";
    this.childrenBySelector = new Map([
      ["h2", heading],
      ["p", paragraph],
      [".tutorial-skip", skip],
      [".tutorial-done", done],
    ]);
  }

  querySelector(selector) {
    return this.childrenBySelector.get(selector) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  remove() {
    this.isConnected = false;
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
  }
}

function fakeBrowser() {
  const anchors = new Map();
  const listeners = new Map();
  const body = {
    children: [],
    append(element) {
      element.parent = this;
      element.isConnected = true;
      this.children.push(element);
    },
  };
  const document = {
    anchors,
    body,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    createElement: () => new FakeElement({
      rect: { left: 0, top: 0, width: 280, height: 100 },
    }),
    querySelector: (selector) => anchors.get(selector) ?? null,
    dispatch(type, event) { listeners.get(type)?.(event); },
  };
  let nextFrame = 1;
  const frames = new Map();
  const window = {
    innerHeight: 800,
    innerWidth: 1200,
    cancelAnimationFrame: vi.fn((id) => frames.delete(id)),
    requestAnimationFrame: vi.fn((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    }),
    runNextFrame() {
      const entry = frames.entries().next().value;
      if (!entry) return false;
      const [id, callback] = entry;
      frames.delete(id);
      callback();
      return true;
    },
    pendingFrames: () => frames.size,
  };
  return { anchors, document, window };
}

function lifecycle(overrides = {}) {
  return {
    read: vi.fn(async () => ({ automaticEligible: true, status: "never-shown" })),
    beginAutomatic: vi.fn(async () => ({ started: true, source: "automatic" })),
    beginManual: vi.fn(async () => ({ started: true, source: "manual" })),
    dismiss: vi.fn(async () => ({ status: "dismissed" })),
    complete: vi.fn(async () => ({ status: "completed" })),
    ...overrides,
  };
}

function fixture(options = {}) {
  const browser = fakeBrowser();
  const newComposer = new FakeElement();
  browser.anchors.set(".new-composer", newComposer);
  const appState = { interactions: [], actionInvocations: [], pendingActionInvocations: [] };
  const viewState = { mainView: "new", currentThreadId: null };
  const persistence = options.lifecycle ?? lifecycle();
  const openNewThread = options.openNewThread ?? vi.fn(async () => {});
  const controller = createOnboardingTutorialController({
    document: browser.document,
    window: browser.window,
    lifecycle: persistence,
    getAppState: () => appState,
    getViewState: () => viewState,
    openNewThread,
  });
  return {
    ...browser,
    appState,
    controller,
    lifecycle: persistence,
    newComposer,
    openNewThread,
    viewState,
  };
}

function coachmark(test) {
  return test.document.body.children.find((element) => (
    element.classList.contains("tutorial-coachmark")
  ));
}

async function startAndCreateThread(test, { interactionId = 11, threadId = 7 } = {}) {
  await test.controller.startManual();
  test.controller.threadCreated({ interactionId, threadId });
  test.viewState.mainView = "thread";
  test.viewState.currentThreadId = threadId;
  test.viewState.currentInteractionId = interactionId;
}

function acceptedInteraction({ actions, interactionId = 11, threadId = 7 }) {
  return {
    id: interactionId,
    threadId,
    completionStatus: "accepted",
    completionOutput: {
      rootLayer: {
        layer: { id: 21 },
        nodes: [{ id: 31, title: "Memory" }],
        actions,
      },
    },
  };
}

describe("onboarding tutorial controller", () => {
  it("starts automatically only when eligible and manually from the ordinary composer", async () => {
    const test = fixture();
    test.lifecycle.read.mockResolvedValueOnce({ automaticEligible: false, status: "never-shown" });
    await expect(test.controller.maybeStartAutomatic({
      providerConnected: false,
      threadCount: 0,
    })).resolves.toBe(false);
    expect(test.openNewThread).not.toHaveBeenCalled();

    await expect(test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    })).resolves.toBe(true);
    expect(test.lifecycle.beginAutomatic).toHaveBeenCalledWith({
      surface: "product",
      providerConnected: true,
      threadCount: 0,
    });
    expect(test.openNewThread).toHaveBeenLastCalledWith({
      prompt: "Why can time seem to pass faster as we get older?",
      source: "automatic",
    });

    await test.controller.startManual();
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.lifecycle.beginManual).toHaveBeenCalledOnce();
    expect(test.openNewThread).toHaveBeenLastCalledWith({
      prompt: "Why can time seem to pass faster as we get older?",
      source: "manual",
    });
  });

  it("cleans up a lifecycle begun before the New Thread surface fails to open", async () => {
    const test = fixture({ openNewThread: vi.fn(async () => { throw new Error("composer failed"); }) });

    await expect(test.controller.startManual()).rejects.toThrow("composer failed");
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.controller.isActive()).toBe(false);
    expect(test.controller.snapshot()).toBeNull();
    expect(coachmark(test)).toBeUndefined();
  });

  it("removes coach UI even when dismissal persistence fails", async () => {
    const test = fixture({
      lifecycle: lifecycle({ dismiss: vi.fn(async () => { throw new Error("disk failed"); }) }),
    });
    await test.controller.startManual();

    await expect(test.controller.skip()).rejects.toThrow("disk failed");
    expect(test.controller.isActive()).toBe(false);
    expect(test.controller.snapshot()).toBeNull();
    expect(test.newComposer.classList.contains("tutorial-target")).toBe(false);
    expect(coachmark(test)).toBeUndefined();
  });

  it("advances only through successful product events and persists completion after submission", async () => {
    const completion = deferred();
    const test = fixture({
      lifecycle: lifecycle({ complete: vi.fn(() => completion.promise) }),
    });
    await startAndCreateThread(test);
    expect(test.controller.snapshot().phase).toBe("awaiting-accepted-response");
    expect(test.window.pendingFrames()).toBe(0);

    const node = new FakeElement();
    test.anchors.set('[data-node="31"]', node);
    test.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "navigate", sourceNodeId: 31, targetLayerId: 22 }],
    })];
    test.controller.syncWorkspace();
    expect(test.controller.snapshot().phase).toBe("select-node");
    expect(coachmark(test).querySelector("h2").textContent).toBe("Select a node");

    test.controller.nodeSelected({ threadId: 8, interactionId: 11, nodeId: 31 });
    expect(test.controller.snapshot().phase).toBe("select-node");
    test.controller.nodeSelected({ threadId: 7, interactionId: 11, nodeId: 31 });
    const action = new FakeElement();
    test.anchors.set('[data-action-id="41"]', action);
    test.window.runNextFrame();
    expect(test.controller.snapshot().phase).toBe("use-action");
    expect(coachmark(test).querySelector("h2").textContent).toBe("Use an action");

    test.controller.actionSucceeded({ threadId: 7, interactionId: 12, actionId: 41 });
    expect(test.controller.snapshot().phase).toBe("use-action");
    test.controller.actionSucceeded({ threadId: 7, interactionId: 11, actionId: 41 });
    const composer = new FakeElement();
    test.anchors.set("#threadComposer", composer);
    test.window.runNextFrame();
    expect(test.controller.snapshot().phase).toBe("write-follow-up");
    expect(coachmark(test).querySelector("h2").textContent).toBe("Ask a follow-up");

    const submitted = test.controller.followupSubmitted({ threadId: 7, interactionId: 12 });
    expect(test.lifecycle.complete).toHaveBeenCalledOnce();
    expect(test.controller.snapshot().phase).toBe("complete");
    expect(coachmark(test).querySelector("h2").textContent).toBe("Ask a follow-up");
    completion.resolve({ status: "completed" });
    await expect(submitted).resolves.toBe(true);
    expect(test.controller.snapshot()).toMatchObject({ phase: "complete", interactionId: 12 });
    expect(coachmark(test).querySelector("h2").textContent).toBe("Tutorial complete.");
    expect(coachmark(test).querySelector("p").classList.contains("hidden")).toBe(true);
    expect(coachmark(test).querySelector(".tutorial-skip").classList.contains("hidden")).toBe(true);
    expect(coachmark(test).querySelector(".tutorial-done").classList.contains("hidden")).toBe(false);
  });

  it("transitions an invoke before its result interaction becomes visible", async () => {
    const test = fixture();
    await startAndCreateThread(test);
    test.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "invoke", sourceNodeId: 31, interactionText: "Go deeper" }],
    })];
    test.controller.syncWorkspace();
    test.controller.nodeSelected({ threadId: 7, interactionId: 11, nodeId: 31 });

    test.controller.actionSucceeded({
      threadId: 7,
      interactionId: 11,
      actionId: 41,
      resultInteractionId: 12,
    });
    expect(test.controller.snapshot()).toMatchObject({
      phase: "awaiting-accepted-response",
      threadId: 7,
      interactionId: 12,
    });

    test.viewState.currentInteractionId = 12;
    test.appState.interactions.push(acceptedInteraction({
      interactionId: 12,
      actions: [{ id: 42, kind: "navigate", sourceNodeId: 31, targetLayerId: 23 }],
    }));
    test.controller.syncWorkspace();

    expect(test.controller.isActive()).toBe(true);
    expect(test.controller.snapshot().phase).toBe("select-node");
  });

  it.each([
    ["no action", acceptedInteraction({ actions: [] }), "no-action"],
    ["failed response", { id: 11, threadId: 7, completionStatus: "failed" }, "response-failed"],
  ])("hides and persists dismissal for %s", async (_label, interaction, reason) => {
    const test = fixture();
    await startAndCreateThread(test);
    test.appState.interactions = [interaction];
    test.controller.syncWorkspace();

    expect(test.controller.isActive()).toBe(false);
    expect(test.controller.snapshot()).toBeNull();
    expect(coachmark(test)).toBeUndefined();
    await vi.waitFor(() => expect(test.lifecycle.dismiss).toHaveBeenCalledOnce());
    expect(reason).toMatch(/^(no-action|response-failed)$/);
  });

  it("dismisses when the presentation leaves its tutorial thread", async () => {
    const test = fixture();
    await startAndCreateThread(test);
    test.viewState.currentThreadId = 8;
    test.controller.presentationChanged();

    await vi.waitFor(() => expect(test.lifecycle.dismiss).toHaveBeenCalledOnce());
    expect(test.controller.isActive()).toBe(false);
  });

  it("dismisses when another interaction in the tutorial thread becomes visible", async () => {
    const test = fixture();
    await startAndCreateThread(test);
    test.viewState.currentInteractionId = 12;
    test.controller.syncWorkspace();

    await vi.waitFor(() => expect(test.lifecycle.dismiss).toHaveBeenCalledOnce());
    expect(test.controller.isActive()).toBe(false);
  });

  it("allows the tutorial thread's transient unhydrated interaction during load", async () => {
    const test = fixture();
    await test.controller.startManual();
    test.controller.threadCreated({ threadId: 7, interactionId: 11 });
    test.viewState.mainView = "thread";
    test.viewState.currentThreadId = 7;
    test.viewState.currentInteractionId = null;

    test.controller.presentationChanged();

    expect(test.controller.isActive()).toBe(true);
    expect(test.controller.snapshot()).toMatchObject({
      phase: "awaiting-accepted-response",
      interactionId: 11,
    });
  });

  it("dismisses explicitly when the provider disconnects", async () => {
    const test = fixture();
    await test.controller.startManual();

    await test.controller.leave();

    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.controller.isActive()).toBe(false);
  });

  it("bounds graph movement tracking after the authored layout settles", async () => {
    const test = fixture();
    await startAndCreateThread(test);
    test.anchors.set('[data-node="31"]', new FakeElement());
    test.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "navigate", sourceNodeId: 31, targetLayerId: 22 }],
    })];
    test.controller.syncWorkspace();

    for (let index = 0; index < 100; index += 1) test.window.runNextFrame();

    expect(test.controller.snapshot().phase).toBe("select-node");
    expect(test.window.pendingFrames()).toBe(0);
  });

  it("maintains coach copy, ARIA linkage, anchor churn, and cleanup", async () => {
    const test = fixture();
    test.newComposer.setAttribute("aria-describedby", "existing-description");
    await test.controller.startManual();

    const coach = coachmark(test);
    expect(coach.getAttribute("role")).toBe("region");
    expect(coach.getAttribute("aria-label")).toBe("Tutorial");
    expect(coach.querySelector("h2").textContent).toBe("Start a thread");
    expect(coach.querySelector("p").textContent).toBe("Edit the question or send it as written.");
    expect(test.newComposer.getAttribute("aria-describedby"))
      .toBe("existing-description onboardingTutorialCopy");
    expect(test.newComposer.classList.contains("tutorial-target")).toBe(true);

    test.controller.threadCreated({ threadId: 7, interactionId: 11 });
    test.viewState.mainView = "thread";
    test.viewState.currentThreadId = 7;
    test.viewState.currentInteractionId = 11;
    const first = new FakeElement();
    test.anchors.set('[data-node="31"]', first);
    test.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "navigate", sourceNodeId: 31, targetLayerId: 22 }],
    })];
    test.controller.syncWorkspace();
    expect(first.classList.contains("tutorial-target")).toBe(true);

    const replacement = new FakeElement();
    test.anchors.set('[data-node="31"]', replacement);
    test.window.runNextFrame();
    expect(first.classList.contains("tutorial-target")).toBe(false);
    expect(replacement.classList.contains("tutorial-target")).toBe(true);

    await test.controller.skip();
    expect(replacement.classList.contains("tutorial-target")).toBe(false);
    expect(replacement.getAttribute("aria-describedby")).toBeNull();
    expect(test.newComposer.getAttribute("aria-describedby")).toBe("existing-description");
    expect(test.window.pendingFrames()).toBe(0);
    expect(coachmark(test)).toBeUndefined();
  });

  it("wires tutorial transitions only after successful renderer operations", async () => {
    const [graph, main, onboarding, threads] = await Promise.all([
      readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/onboarding-tutorial.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/threads.js", import.meta.url), "utf8"),
    ]);
    expect(threads.indexOf("createdInteraction = await request"))
      .toBeLessThan(threads.indexOf("followupSubmitted({"));
    expect(graph).not.toContain("followupSubmitted({");
    expect(graph).toContain("if (navigated === true)");
    expect(graph).toContain('onInvokeAction: (action) => import("./threads.js")');
    expect(threads.indexOf("onboardingTutorialController()?.actionSucceeded({"))
      .toBeLessThan(threads.indexOf("viewState.currentInteractionId = response.interaction.id"));
    expect(threads.indexOf('const thread = await request("/api/threads", {'))
      .toBeLessThan(threads.indexOf("onboardingTutorialController()?.threadCreated({"));
    expect(threads).toContain("return createdInteraction;");
    expect(main).toContain("Boolean(viewState.selectedPermissionProfileId)");
    expect(main).toContain("newThreadModelSelectionReady()");
    expect(main.indexOf("if (!ready) return false;"))
      .toBeLessThan(main.indexOf("tutorial.maybeStartAutomatic({"));
    expect(main).toContain("if (!providerConnected) await onboardingTutorialController()?.leave();");
    expect(main.indexOf("await desktop?.account.logout();"))
      .toBeLessThan(main.indexOf("await onboardingTutorialController()?.leave();"));
    expect(main.indexOf("await onboardingTutorialController()?.leave();"))
      .toBeLessThan(main.indexOf("await refreshAccount();"));
    expect(onboarding).toContain('role="status" aria-live="polite"');
    expect(onboarding).not.toContain('addEventListener("keydown", escapeHandler, true)');
  });
});

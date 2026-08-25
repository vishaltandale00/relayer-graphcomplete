import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  coachmarkViewportPosition,
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
  const appState = {
    threads: [],
    interactions: [],
    actionInvocations: [],
    pendingActionInvocations: [],
  };
  const viewState = { mainView: "new", currentThreadId: null };
  const persistence = options.lifecycle ?? lifecycle();
  const openNewThread = options.openNewThread ?? vi.fn(async () => {});
  const controller = createOnboardingTutorialController({
    document: browser.document,
    window: browser.window,
    lifecycle: persistence,
    getAppState: () => appState,
    getViewState: () => viewState,
    isComposerReady: options.isComposerReady,
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
  it.each([
    ["below when it fits", { left: 100, top: 100, width: 80, height: 40 }, { left: 10, top: 150 }],
    ["above near the bottom", { left: 100, top: 720, width: 80, height: 40 }, { left: 10, top: 610 }],
    ["inside the viewport for a target below it", { left: 100, top: 850, width: 80, height: 40 }, { left: 10, top: 690 }],
    ["inside the viewport for a target above it", { left: 100, top: -80, width: 80, height: 40 }, { left: 10, top: 10 }],
    ["inside the viewport for a target to its right", { left: 1250, top: 100, width: 80, height: 40 }, { left: 910, top: 150 }],
  ])("positions the coachmark %s", (_label, targetRect, expected) => {
    expect(coachmarkViewportPosition(
      { ...targetRect, right: targetRect.left + targetRect.width, bottom: targetRect.top + targetRect.height },
      { left: 0, top: 0, width: 280, height: 100, right: 280, bottom: 100 },
      { viewportWidth: 1200, viewportHeight: 800 },
    )).toEqual(expected);
  });

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
    expect(test.openNewThread).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: "Why can time seem to pass faster as we get older?",
      source: "automatic",
      guard: expect.any(Function),
    }));

    await test.controller.startManual();
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.lifecycle.beginManual).toHaveBeenCalledOnce();
    expect(test.openNewThread).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: "Why can time seem to pass faster as we get older?",
      source: "manual",
      guard: expect.any(Function),
    }));
  });

  it("does not consume manual launch state until the composer is ready", async () => {
    let ready = false;
    const test = fixture({ isComposerReady: () => ready });

    await expect(test.controller.startManual()).resolves.toBe(false);
    expect(test.lifecycle.beginManual).not.toHaveBeenCalled();
    expect(test.lifecycle.dismiss).not.toHaveBeenCalled();
    expect(test.openNewThread).not.toHaveBeenCalled();
    expect(test.controller.isActive()).toBe(false);

    ready = true;
    await expect(test.controller.startManual()).resolves.toBe(true);
    expect(test.lifecycle.beginManual).toHaveBeenCalledOnce();
    expect(test.openNewThread).toHaveBeenCalledOnce();
    expect(test.controller.isActive()).toBe(true);
  });

  it("abandons a manual launch when composer readiness is lost during lifecycle begin", async () => {
    const beginning = deferred();
    let ready = true;
    const test = fixture({
      isComposerReady: () => ready,
      lifecycle: lifecycle({ beginManual: vi.fn(() => beginning.promise) }),
    });

    const starting = test.controller.startManual();
    await vi.waitFor(() => expect(test.lifecycle.beginManual).toHaveBeenCalledOnce());
    ready = false;
    beginning.resolve({ started: true, source: "manual" });

    await expect(starting).resolves.toBe(false);
    expect(test.openNewThread).not.toHaveBeenCalled();
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.controller.isActive()).toBe(false);
  });

  it("guards manual composer mutation when readiness is lost during preparation", async () => {
    const preparation = deferred();
    const mutateComposer = vi.fn();
    let ready = true;
    const openNewThread = vi.fn(async ({ guard }) => {
      await preparation.promise;
      if (!guard()) return false;
      mutateComposer();
      return true;
    });
    const test = fixture({ isComposerReady: () => ready, openNewThread });

    const starting = test.controller.startManual();
    await vi.waitFor(() => expect(openNewThread).toHaveBeenCalledOnce());
    ready = false;
    preparation.resolve();

    await expect(starting).resolves.toBe(false);
    expect(mutateComposer).not.toHaveBeenCalled();
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.controller.isActive()).toBe(false);
  });

  it("does not auto-start when a thread appears during the lifecycle eligibility read", async () => {
    const eligibility = deferred();
    const test = fixture({
      lifecycle: lifecycle({ read: vi.fn(() => eligibility.promise) }),
    });

    const starting = test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    test.appState.threads.push({ id: 7 });
    eligibility.resolve({ automaticEligible: true, status: "never-shown" });

    await expect(starting).resolves.toBe(false);
    expect(test.lifecycle.beginAutomatic).not.toHaveBeenCalled();
    expect(test.openNewThread).not.toHaveBeenCalled();
    expect(test.controller.isActive()).toBe(false);
  });

  it("does not auto-start when a thread appears during lifecycle begin", async () => {
    const beginning = deferred();
    const test = fixture({
      lifecycle: lifecycle({ beginAutomatic: vi.fn(() => beginning.promise) }),
    });

    const starting = test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(test.lifecycle.beginAutomatic).toHaveBeenCalledOnce());
    test.appState.threads.push({ id: 7 });
    beginning.resolve({ started: true, source: "automatic" });

    await expect(starting).resolves.toBe(false);
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.openNewThread).not.toHaveBeenCalled();
    expect(test.controller.isActive()).toBe(false);
    expect(test.controller.snapshot()).toBeNull();
    expect(coachmark(test)).toBeUndefined();
  });

  it("guards the composer mutation boundary when a thread appears during preparation", async () => {
    const preparation = deferred();
    const mutateComposer = vi.fn();
    const openNewThread = vi.fn(async ({ guard }) => {
      await preparation.promise;
      if (!guard()) return false;
      mutateComposer();
      return true;
    });
    const test = fixture({ openNewThread });

    const starting = test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(openNewThread).toHaveBeenCalledOnce());
    expect(test.controller.isActive()).toBe(false);
    test.appState.threads.push({ id: 7 });
    preparation.resolve();

    await expect(starting).resolves.toBe(false);
    expect(mutateComposer).not.toHaveBeenCalled();
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.controller.isActive()).toBe(false);
    expect(test.controller.snapshot()).toBeNull();
    expect(coachmark(test)).toBeUndefined();
  });

  it("lets a pending manual start supersede a pending automatic start", async () => {
    const automaticBegin = deferred();
    const manualBegin = deferred();
    const test = fixture({
      lifecycle: lifecycle({
        beginAutomatic: vi.fn(() => automaticBegin.promise),
        beginManual: vi.fn(() => manualBegin.promise),
      }),
    });

    const automaticStart = test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(test.lifecycle.beginAutomatic).toHaveBeenCalledOnce());
    const manualStart = test.controller.startManual();
    await vi.waitFor(() => expect(test.lifecycle.beginManual).toHaveBeenCalledOnce());

    automaticBegin.resolve({ started: true, source: "automatic" });
    await expect(automaticStart).resolves.toBe(false);
    expect(test.openNewThread).not.toHaveBeenCalled();

    manualBegin.resolve({ started: true, source: "manual" });
    await expect(manualStart).resolves.toBe(true);
    expect(test.openNewThread).toHaveBeenCalledOnce();
    expect(test.openNewThread).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Why can time seem to pass faster as we get older?",
      source: "manual",
      guard: expect.any(Function),
    }));
    expect(test.controller.isActive()).toBe(true);
    expect(test.controller.snapshot()).toMatchObject({ phase: "initial-composer" });
  });

  it("does not let an automatic probe supersede a pending manual start", async () => {
    const manualBegin = deferred();
    const test = fixture({
      lifecycle: lifecycle({
        beginManual: vi.fn(() => manualBegin.promise),
      }),
    });

    const manualStart = test.controller.startManual();
    await vi.waitFor(() => expect(test.lifecycle.beginManual).toHaveBeenCalledOnce());
    const automaticStart = test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await expect(automaticStart).resolves.toBe(false);

    manualBegin.resolve({ started: true, source: "manual" });
    await expect(manualStart).resolves.toBe(true);
    expect(test.lifecycle.read).not.toHaveBeenCalled();
    expect(test.lifecycle.beginAutomatic).not.toHaveBeenCalled();
    expect(test.openNewThread).toHaveBeenCalledOnce();
    expect(test.openNewThread).toHaveBeenCalledWith(expect.objectContaining({
      source: "manual",
      guard: expect.any(Function),
    }));
    expect(test.controller.isActive()).toBe(true);
    expect(test.controller.snapshot()).toMatchObject({ phase: "initial-composer" });
  });

  it("does not let a second automatic probe supersede a pending automatic start", async () => {
    const automaticBegin = deferred();
    const test = fixture({
      lifecycle: lifecycle({
        beginAutomatic: vi.fn(() => automaticBegin.promise),
      }),
    });

    const firstStart = test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(test.lifecycle.beginAutomatic).toHaveBeenCalledOnce());

    await expect(test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    })).resolves.toBe(false);
    expect(test.lifecycle.read).toHaveBeenCalledOnce();
    expect(test.lifecycle.beginAutomatic).toHaveBeenCalledOnce();

    automaticBegin.resolve({ started: true, source: "automatic" });
    await expect(firstStart).resolves.toBe(true);
    expect(test.openNewThread).toHaveBeenCalledOnce();
    expect(test.openNewThread).toHaveBeenCalledWith(expect.objectContaining({
      source: "automatic",
      guard: expect.any(Function),
    }));
    expect(test.controller.isActive()).toBe(true);
    expect(test.controller.snapshot()).toMatchObject({ phase: "initial-composer" });
  });

  it("lets a Settings takeover revoke an automatic start during lifecycle begin", async () => {
    const automaticBegin = deferred();
    const dismiss = vi.fn()
      .mockResolvedValueOnce({ status: "dismissed" })
      .mockRejectedValueOnce(new Error("redundant cleanup must not run"));
    const test = fixture({
      lifecycle: lifecycle({
        beginAutomatic: vi.fn(() => automaticBegin.promise),
        dismiss,
      }),
    });

    const starting = test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(test.lifecycle.beginAutomatic).toHaveBeenCalledOnce());

    expect(test.controller.cancelPendingAutomatic()).toBe(true);
    await vi.waitFor(() => expect(test.lifecycle.dismiss).toHaveBeenCalledOnce());
    automaticBegin.resolve({ started: true, source: "automatic" });

    await expect(starting).resolves.toBe(false);
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.openNewThread).not.toHaveBeenCalled();
    expect(test.controller.isActive()).toBe(false);
  });

  it("guards composer mutation when prompt typing takes over during automatic preparation", async () => {
    const preparation = deferred();
    const mutateComposer = vi.fn();
    const openNewThread = vi.fn(async ({ guard }) => {
      await preparation.promise;
      if (!guard()) return false;
      mutateComposer();
      return true;
    });
    const test = fixture({ openNewThread });

    const starting = test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(openNewThread).toHaveBeenCalledOnce());

    expect(test.controller.cancelPendingAutomatic()).toBe(true);
    preparation.resolve();

    await expect(starting).resolves.toBe(false);
    expect(mutateComposer).not.toHaveBeenCalled();
    expect(test.controller.isActive()).toBe(false);
  });

  it("does not let automatic takeover cancellation revoke a pending manual start", async () => {
    const manualBegin = deferred();
    const test = fixture({
      lifecycle: lifecycle({ beginManual: vi.fn(() => manualBegin.promise) }),
    });

    const starting = test.controller.startManual();
    await vi.waitFor(() => expect(test.lifecycle.beginManual).toHaveBeenCalledOnce());
    expect(test.controller.cancelPendingAutomatic()).toBe(false);
    expect(test.lifecycle.dismiss).not.toHaveBeenCalled();

    manualBegin.resolve({ started: true, source: "manual" });
    await expect(starting).resolves.toBe(true);
    expect(test.openNewThread).toHaveBeenCalledOnce();
    expect(test.controller.isActive()).toBe(true);
  });

  it("releases automatic ownership when the lifecycle eligibility read rejects", async () => {
    const test = fixture({
      lifecycle: lifecycle({
        read: vi.fn()
          .mockRejectedValueOnce(new Error("settings read failed"))
          .mockResolvedValue({ automaticEligible: true, status: "never-shown" }),
      }),
    });

    await expect(test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    })).rejects.toThrow("settings read failed");

    await expect(test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    })).resolves.toBe(true);
    expect(test.lifecycle.read).toHaveBeenCalledTimes(2);
    expect(test.lifecycle.beginAutomatic).toHaveBeenCalledOnce();
    expect(test.openNewThread).toHaveBeenCalledOnce();
  });

  it("releases automatic ownership when lifecycle begin rejects", async () => {
    const test = fixture({
      lifecycle: lifecycle({
        beginAutomatic: vi.fn()
          .mockRejectedValueOnce(new Error("automatic begin failed"))
          .mockResolvedValue({ started: true, source: "automatic" }),
        dismiss: vi.fn(async () => { throw new Error("cleanup failed"); }),
      }),
    });

    await expect(test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    })).rejects.toThrow("automatic begin failed");

    await expect(test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    })).resolves.toBe(true);
    expect(test.lifecycle.beginAutomatic).toHaveBeenCalledTimes(2);
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.openNewThread).toHaveBeenCalledOnce();
  });

  it("releases manual ownership when lifecycle begin rejects", async () => {
    const test = fixture({
      lifecycle: lifecycle({
        beginManual: vi.fn()
          .mockRejectedValueOnce(new Error("manual begin failed"))
          .mockResolvedValue({ started: true, source: "manual" }),
        dismiss: vi.fn(async () => { throw new Error("cleanup failed"); }),
      }),
    });

    await expect(test.controller.startManual()).rejects.toThrow("manual begin failed");
    await expect(test.controller.startManual()).resolves.toBe(true);
    expect(test.lifecycle.beginManual).toHaveBeenCalledTimes(2);
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.openNewThread).toHaveBeenCalledOnce();
  });

  it("lets leaving revoke a pending lifecycle begin before it can open the composer", async () => {
    const manualBegin = deferred();
    const test = fixture({
      lifecycle: lifecycle({ beginManual: vi.fn(() => manualBegin.promise) }),
    });

    const starting = test.controller.startManual();
    await vi.waitFor(() => expect(test.lifecycle.beginManual).toHaveBeenCalledOnce());
    await test.controller.leave();
    manualBegin.resolve({ started: true, source: "manual" });

    await expect(starting).resolves.toBe(false);
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.openNewThread).not.toHaveBeenCalled();
    expect(test.controller.isActive()).toBe(false);
    expect(test.controller.snapshot()).toBeNull();
  });

  it("cleans up a lifecycle begun before the New Thread surface fails to open", async () => {
    const openNewThread = vi.fn()
      .mockRejectedValueOnce(new Error("composer failed"))
      .mockResolvedValue(true);
    const test = fixture({
      lifecycle: lifecycle({ dismiss: vi.fn(async () => { throw new Error("cleanup failed"); }) }),
      openNewThread,
    });

    await expect(test.controller.startManual()).rejects.toThrow("composer failed");
    expect(test.lifecycle.dismiss).toHaveBeenCalledOnce();
    expect(test.controller.isActive()).toBe(false);
    expect(test.controller.snapshot()).toBeNull();
    expect(coachmark(test)).toBeUndefined();

    await expect(test.controller.startManual()).resolves.toBe(true);
    expect(openNewThread).toHaveBeenCalledTimes(2);
    expect(test.controller.isActive()).toBe(true);
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
    const prompt = new FakeElement();
    test.anchors.set("#threadComposer", composer);
    test.anchors.set("#threadPrompt", prompt);
    test.window.runNextFrame();
    expect(test.controller.snapshot().phase).toBe("write-follow-up");
    expect(coachmark(test).querySelector("h2").textContent).toBe("Ask a follow-up");

    const submitted = test.controller.followupSubmitted({ threadId: 7, interactionId: 12 });
    expect(test.lifecycle.complete).toHaveBeenCalledOnce();
    expect(test.controller.snapshot().phase).toBe("write-follow-up");
    expect(coachmark(test).querySelector("h2").textContent).toBe("Ask a follow-up");
    completion.resolve({ status: "completed" });
    await expect(submitted).resolves.toBe(true);
    expect(test.controller.snapshot()).toMatchObject({ phase: "complete", interactionId: 12 });
    expect(coachmark(test).querySelector("h2").textContent).toBe("Tutorial complete.");
    expect(coachmark(test).querySelector("p").classList.contains("hidden")).toBe(true);
    expect(coachmark(test).querySelector(".tutorial-skip").classList.contains("hidden")).toBe(true);
    expect(coachmark(test).querySelector(".tutorial-done").classList.contains("hidden")).toBe(false);
    expect(prompt.classList.contains("tutorial-target")).toBe(false);
  });

  it("does not render or enter completion when lifecycle persistence rejects", async () => {
    const test = fixture({
      lifecycle: lifecycle({
        complete: vi.fn(async () => { throw new Error("settings write failed"); }),
      }),
    });
    await startAndCreateThread(test);
    test.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "navigate", sourceNodeId: 31, targetLayerId: 22 }],
    })];
    test.controller.syncWorkspace();
    test.controller.nodeSelected({ threadId: 7, interactionId: 11, nodeId: 31 });
    test.controller.actionSucceeded({ threadId: 7, interactionId: 11, actionId: 41 });

    await expect(test.controller.followupSubmitted({ threadId: 7, interactionId: 12 }))
      .rejects.toThrow("settings write failed");
    expect(test.controller.snapshot()).toMatchObject({
      phase: "write-follow-up",
      threadId: 7,
      interactionId: 11,
    });
    expect(coachmark(test).querySelector("h2").textContent).toBe("Ask a follow-up");
    expect(coachmark(test).querySelector(".tutorial-skip").classList.contains("hidden")).toBe(false);
    expect(coachmark(test).querySelector(".tutorial-done").classList.contains("hidden")).toBe(true);
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

  it("keeps the select-node coachmark visible while highlighting an offscreen target", async () => {
    const test = fixture();
    await startAndCreateThread(test);
    const node = new FakeElement({
      rect: { left: 1150, top: 850, width: 100, height: 40 },
    });
    test.anchors.set('[data-node="31"]', node);
    test.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "navigate", sourceNodeId: 31, targetLayerId: 22 }],
    })];

    test.controller.syncWorkspace();

    const coach = coachmark(test);
    expect(coach.style.left).toBe("910px");
    expect(coach.style.top).toBe("690px");
    expect(node.classList.contains("tutorial-target")).toBe(true);
    expect(node.getAttribute("aria-describedby")).toBe("onboardingTutorialCopy");
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
    const [graph, main, onboarding, threads, picker, composerPicker, permissions, navigation] = await Promise.all([
      readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/onboarding-tutorial.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/threads.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/model-picker.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/composer-model-picker.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/permission-profiles.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/navigation.js", import.meta.url), "utf8"),
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
    expect(main).toContain("isComposerReady: tutorialComposerReady,");
    expect(main.indexOf("if (!tutorialComposerReady()) {"))
      .toBeLessThan(main.indexOf("await onboardingTutorialController()?.startManual();"));
    expect(main).toContain('$("#startTutorial").disabled = !ready;');
    expect(onboarding.indexOf('if (source === "manual" && !isComposerReady()) return false;'))
      .toBeLessThan(onboarding.indexOf("const attempt = ownedAttempt ?? claimStart(source);"));
    expect(main).toContain('async function openNewThreadComposer({ prompt = "", guard = null } = {})');
    expect(main.indexOf("const applyPermissionProfiles = await preparePermissionProfiles("))
      .toBeLessThan(main.indexOf("if (guard && !guard()) return false;"));
    expect(main.indexOf("if (guard && !guard()) return false;"))
      .toBeLessThan(main.indexOf("applyPermissionProfiles?.();"));
    expect(main.indexOf("applyPermissionProfiles?.();"))
      .toBeLessThan(main.lastIndexOf("if (guard && !guard()) return false;"));
    expect(main.lastIndexOf("if (guard && !guard()) return false;"))
      .toBeLessThan(main.indexOf("cancelNavigationHistory();"));
    expect(main.indexOf("if (!ready) return false;"))
      .toBeLessThan(main.indexOf("tutorial.maybeStartAutomatic({"));
    expect(onboarding).toContain("guard: canOpen,");
    expect(onboarding).toContain("&& isComposerReady()");
    expect(onboarding).toContain("cancelPendingAutomatic,");
    expect(main.match(/takeOverPendingAutomaticTutorial\(\);/g)).toHaveLength(5);
    expect(main).toContain(`$("#newThreadPrompt").oninput = () => {
    takeOverPendingAutomaticTutorial();`);
    expect(main).toContain(`$("#settingsButton").onclick = async () => {
    takeOverPendingAutomaticTutorial();`);
    expect(main).toContain("onUserTakeover: takeOverPendingAutomaticTutorial,");
    expect(composerPicker).toContain("onUserTakeover,");
    expect(picker).toContain("onUserTakeover();");
    expect(permissions).toContain("onboardingTutorialController()?.cancelPendingAutomatic();");
    expect(navigation).toContain("if (userInitiated) onboardingTutorialController()?.cancelPendingAutomatic();");
    expect(threads.indexOf("onboardingTutorialController()?.cancelPendingAutomatic();"))
      .toBeLessThan(threads.indexOf('const input = $("#newThreadPrompt");'));
    expect(main).toContain("if (!providerConnected) await onboardingTutorialController()?.leave();");
    expect(main.indexOf("await desktop?.account.logout();"))
      .toBeLessThan(main.indexOf("await onboardingTutorialController()?.leave();"));
    expect(main.indexOf("await onboardingTutorialController()?.leave();"))
      .toBeLessThan(main.indexOf("await refreshAccount();"));
    expect(onboarding).toContain('role="status" aria-live="polite"');
    expect(onboarding).not.toContain('addEventListener("keydown", escapeHandler, true)');
  });
});

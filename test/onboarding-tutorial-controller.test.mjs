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
  it("walks the tutorial lifecycle from eligibility through completion", async () => {
    const completion = deferred();
    const test = fixture({
      lifecycle: lifecycle({ complete: vi.fn(() => completion.promise) }),
    });

    test.lifecycle.read.mockResolvedValueOnce({ automaticEligible: false, status: "never-shown" });
    await expect(test.controller.maybeStartAutomatic({
      providerConnected: false,
      threadCount: 0,
    }), "ineligible probe stays idle").resolves.toBe(false);
    expect(test.openNewThread, "ineligible probe leaves the composer alone").not.toHaveBeenCalled();

    await expect(test.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    }), "eligible automatic start").resolves.toBe(true);
    expect(test.lifecycle.beginAutomatic, "automatic begin receives its context").toHaveBeenCalledWith({
      surface: "product",
      providerConnected: true,
      threadCount: 0,
    });
    expect(test.openNewThread, "automatic launch opens the ordinary composer").toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: "Why can time seem to pass faster as we get older?",
      source: "automatic",
      guard: expect.any(Function),
    }));

    await test.controller.startManual();
    expect(test.lifecycle.dismiss, "manual start dismisses the pending coach").toHaveBeenCalledOnce();
    expect(test.lifecycle.beginManual, "manual start records its begin").toHaveBeenCalledOnce();
    expect(test.openNewThread, "manual launch opens the ordinary composer").toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: "Why can time seem to pass faster as we get older?",
      source: "manual",
      guard: expect.any(Function),
    }));

    test.controller.threadCreated({ interactionId: 11, threadId: 7 });
    test.viewState.mainView = "thread";
    test.viewState.currentThreadId = 7;
    test.viewState.currentInteractionId = 11;
    expect(test.controller.snapshot().phase, "thread creation waits for the response").toBe("awaiting-accepted-response");
    expect(test.window.pendingFrames(), "no positioning before guidance").toBe(0);

    const node = new FakeElement();
    test.anchors.set('[data-node="31"]', node);
    test.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "navigate", sourceNodeId: 31, targetLayerId: 22 }],
    })];
    test.controller.syncWorkspace();
    expect(test.controller.snapshot().phase, "accepted response starts node guidance").toBe("select-node");
    expect(coachmark(test).querySelector("h2").textContent, "node guidance copy").toBe("Select a node");

    test.controller.nodeSelected({ threadId: 8, interactionId: 11, nodeId: 31 });
    expect(test.controller.snapshot().phase, "foreign thread selection is ignored").toBe("select-node");
    test.controller.nodeSelected({ threadId: 7, interactionId: 11, nodeId: 31 });
    const action = new FakeElement();
    test.anchors.set('[data-action-id="41"]', action);
    test.window.runNextFrame();
    expect(test.controller.snapshot().phase, "matching selection starts action guidance").toBe("use-action");
    expect(coachmark(test).querySelector("h2").textContent, "action guidance copy").toBe("Use an action");

    test.controller.actionSucceeded({ threadId: 7, interactionId: 12, actionId: 41 });
    expect(test.controller.snapshot().phase, "foreign interaction success is ignored").toBe("use-action");
    test.controller.actionSucceeded({ threadId: 7, interactionId: 11, actionId: 41 });
    const composer = new FakeElement();
    const prompt = new FakeElement();
    test.anchors.set("#threadComposer", composer);
    test.anchors.set("#threadPrompt", prompt);
    test.window.runNextFrame();
    expect(test.controller.snapshot().phase, "matching success starts follow-up guidance").toBe("write-follow-up");
    expect(coachmark(test).querySelector("h2").textContent, "follow-up guidance copy").toBe("Ask a follow-up");

    const submitted = test.controller.followupSubmitted({ threadId: 7, interactionId: 12 });
    expect(test.lifecycle.complete, "submission persists completion").toHaveBeenCalledOnce();
    expect(test.controller.snapshot().phase, "pending persistence keeps follow-up guidance").toBe("write-follow-up");
    expect(coachmark(test).querySelector("h2").textContent, "pending persistence copy").toBe("Ask a follow-up");
    completion.resolve({ status: "completed" });
    await expect(submitted, "follow-up completion").resolves.toBe(true);
    expect(test.controller.snapshot(), "completed tutorial snapshot").toMatchObject({ phase: "complete", interactionId: 12 });
    expect(coachmark(test).querySelector("h2").textContent, "completion copy").toBe("Tutorial complete.");
    expect(coachmark(test).querySelector("p").classList.contains("hidden"), "completion hides the body").toBe(true);
    expect(coachmark(test).querySelector(".tutorial-skip").classList.contains("hidden"), "completion hides skip").toBe(true);
    expect(coachmark(test).querySelector(".tutorial-done").classList.contains("hidden"), "completion shows done").toBe(false);
    expect(prompt.classList.contains("tutorial-target"), "completion releases the target").toBe(false);

    const invoke = fixture();
    await startAndCreateThread(invoke);
    invoke.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "invoke", sourceNodeId: 31, interactionText: "Go deeper" }],
    })];
    invoke.controller.syncWorkspace();
    invoke.controller.nodeSelected({ threadId: 7, interactionId: 11, nodeId: 31 });
    invoke.controller.actionSucceeded({
      threadId: 7,
      interactionId: 11,
      actionId: 41,
      resultInteractionId: 12,
    });
    expect(invoke.controller.snapshot(), "invoke result becomes the awaited interaction").toMatchObject({
      phase: "awaiting-accepted-response",
      threadId: 7,
      interactionId: 12,
    });
    invoke.viewState.currentInteractionId = 12;
    invoke.appState.interactions.push(acceptedInteraction({
      interactionId: 12,
      actions: [{ id: 42, kind: "navigate", sourceNodeId: 31, targetLayerId: 23 }],
    }));
    invoke.controller.syncWorkspace();
    expect(invoke.controller.isActive(), "tutorial survives the invoke handoff").toBe(true);
    expect(invoke.controller.snapshot().phase, "invoke result restarts node guidance").toBe("select-node");

    const rejected = fixture({
      lifecycle: lifecycle({
        complete: vi.fn(async () => { throw new Error("settings write failed"); }),
      }),
    });
    await startAndCreateThread(rejected);
    rejected.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "navigate", sourceNodeId: 31, targetLayerId: 22 }],
    })];
    rejected.controller.syncWorkspace();
    rejected.controller.nodeSelected({ threadId: 7, interactionId: 11, nodeId: 31 });
    rejected.controller.actionSucceeded({ threadId: 7, interactionId: 11, actionId: 41 });

    await expect(rejected.controller.followupSubmitted({ threadId: 7, interactionId: 12 }),
      "completion persistence failure surfaces").rejects.toThrow("settings write failed");
    expect(rejected.controller.snapshot(), "failed persistence keeps follow-up guidance").toMatchObject({
      phase: "write-follow-up",
      threadId: 7,
      interactionId: 11,
    });
    expect(coachmark(rejected).querySelector("h2").textContent, "failed persistence copy").toBe("Ask a follow-up");
    expect(coachmark(rejected).querySelector(".tutorial-skip").classList.contains("hidden"), "failed persistence keeps skip").toBe(false);
    expect(coachmark(rejected).querySelector(".tutorial-done").classList.contains("hidden"), "failed persistence hides done").toBe(true);
  }, 15_000);

  it("places, tracks, and cleans the coach surface across viewport and anchor churn", async () => {
    const placements = [
      ["below when it fits", { left: 100, top: 100, width: 80, height: 40 }, { left: 10, top: 150 }],
      ["above near the bottom", { left: 100, top: 720, width: 80, height: 40 }, { left: 10, top: 610 }],
      ["inside the viewport for a target below it", { left: 100, top: 850, width: 80, height: 40 }, { left: 10, top: 690 }],
      ["inside the viewport for a target above it", { left: 100, top: -80, width: 80, height: 40 }, { left: 10, top: 10 }],
      ["inside the viewport for a target to its right", { left: 1250, top: 100, width: 80, height: 40 }, { left: 910, top: 150 }],
    ];
    expect(placements, "placement matrix inventory").toHaveLength(5);
    for (const [label, targetRect, expected] of placements) {
      expect(coachmarkViewportPosition(
        { ...targetRect, right: targetRect.left + targetRect.width, bottom: targetRect.top + targetRect.height },
        { left: 0, top: 0, width: 280, height: 100, right: 280, bottom: 100 },
        { viewportWidth: 1200, viewportHeight: 800 },
      ), `coachmark placement ${label}`).toEqual(expected);
    }

    const test = fixture();
    test.newComposer.setAttribute("aria-describedby", "existing-description");
    await test.controller.startManual();

    const opening = coachmark(test);
    expect(opening.getAttribute("role"), "coach landmark role").toBe("region");
    expect(opening.getAttribute("aria-label"), "coach landmark label").toBe("Tutorial");
    expect(opening.querySelector("h2").textContent, "composer guidance heading").toBe("Start a thread");
    expect(opening.querySelector("p").textContent, "composer guidance copy").toBe("Edit the question or send it as written.");
    expect(test.newComposer.getAttribute("aria-describedby"), "composer description appended").toBe("existing-description onboardingTutorialCopy");
    expect(test.newComposer.classList.contains("tutorial-target"), "composer highlighted").toBe(true);

    test.controller.threadCreated({ threadId: 7, interactionId: 11 });
    test.viewState.mainView = "thread";
    test.viewState.currentThreadId = 7;
    test.viewState.currentInteractionId = 11;
    const first = new FakeElement({
      rect: { left: 1150, top: 850, width: 100, height: 40 },
    });
    test.anchors.set('[data-node="31"]', first);
    test.appState.interactions = [acceptedInteraction({
      actions: [{ id: 41, kind: "navigate", sourceNodeId: 31, targetLayerId: 22 }],
    })];
    test.controller.syncWorkspace();

    expect(first.classList.contains("tutorial-target"), "offscreen anchor stays highlighted").toBe(true);
    expect(first.getAttribute("aria-describedby"), "offscreen anchor keeps ARIA linkage").toBe("onboardingTutorialCopy");
    const positioned = coachmark(test);
    expect(positioned.style.left, "offscreen target clamps the coach left").toBe("910px");
    expect(positioned.style.top, "offscreen target clamps the coach top").toBe("690px");

    const replacement = new FakeElement();
    test.anchors.set('[data-node="31"]', replacement);
    test.window.runNextFrame();
    expect(first.classList.contains("tutorial-target"), "stale anchor loses the highlight").toBe(false);
    expect(replacement.classList.contains("tutorial-target"), "replacement anchor gains the highlight").toBe(true);

    for (let index = 0; index < 100; index += 1) test.window.runNextFrame();
    expect(test.controller.snapshot().phase, "movement tracking settles on node guidance").toBe("select-node");
    expect(test.window.pendingFrames(), "movement tracking stops scheduling frames").toBe(0);

    await test.controller.skip();
    expect(replacement.classList.contains("tutorial-target"), "skip releases the highlight").toBe(false);
    expect(replacement.getAttribute("aria-describedby"), "skip clears anchor ARIA linkage").toBeNull();
    expect(test.newComposer.getAttribute("aria-describedby"), "skip restores the composer description").toBe("existing-description");
    expect(test.window.pendingFrames(), "skip drains pending frames").toBe(0);
    expect(coachmark(test), "skip removes the coachmark").toBeUndefined();
  }, 15_000);

  it("abandons pending launches when their precondition evaporates in any window", async () => {
    let gateReady = false;
    const gated = fixture({ isComposerReady: () => gateReady });
    await expect(gated.controller.startManual(), "manual start waits for composer readiness").resolves.toBe(false);
    expect(gated.lifecycle.beginManual, "unreadiness consumes no begin").not.toHaveBeenCalled();
    expect(gated.lifecycle.dismiss, "unreadiness consumes no dismiss").not.toHaveBeenCalled();
    expect(gated.openNewThread, "unreadiness consumes no composer launch").not.toHaveBeenCalled();
    expect(gated.controller.isActive(), "unreadiness stays inactive").toBe(false);
    gateReady = true;
    await expect(gated.controller.startManual(), "manual start proceeds once ready").resolves.toBe(true);
    expect(gated.lifecycle.beginManual, "readiness begins exactly once").toHaveBeenCalledOnce();
    expect(gated.openNewThread, "readiness launches exactly once").toHaveBeenCalledOnce();
    expect(gated.controller.isActive(), "readiness activates").toBe(true);

    const beginInterruption = deferred();
    let beginReady = true;
    const lostDuringBegin = fixture({
      isComposerReady: () => beginReady,
      lifecycle: lifecycle({ beginManual: vi.fn(() => beginInterruption.promise) }),
    });
    const beginAbandoned = lostDuringBegin.controller.startManual();
    await vi.waitFor(() => expect(lostDuringBegin.lifecycle.beginManual, "begin started").toHaveBeenCalledOnce());
    beginReady = false;
    beginInterruption.resolve({ started: true, source: "manual" });
    await expect(beginAbandoned, "lost readiness abandons a pending begin").resolves.toBe(false);
    expect(lostDuringBegin.openNewThread, "lost readiness never opens the composer").not.toHaveBeenCalled();
    expect(lostDuringBegin.lifecycle.dismiss, "abandoned begin dismisses").toHaveBeenCalledOnce();
    expect(lostDuringBegin.controller.isActive(), "abandoned begin deactivates").toBe(false);

    const preparationInterruption = deferred();
    const beginMutation = vi.fn();
    let preparationReady = true;
    const beginOpenNewThread = vi.fn(async ({ guard }) => {
      await preparationInterruption.promise;
      if (!guard()) return false;
      beginMutation();
      return true;
    });
    const lostDuringPreparation = fixture({
      isComposerReady: () => preparationReady,
      openNewThread: beginOpenNewThread,
    });
    const preparationAbandoned = lostDuringPreparation.controller.startManual();
    await vi.waitFor(() => expect(beginOpenNewThread, "preparation started").toHaveBeenCalledOnce());
    preparationReady = false;
    preparationInterruption.resolve();
    await expect(preparationAbandoned, "lost readiness abandons preparation").resolves.toBe(false);
    expect(beginMutation, "lost readiness guards the composer mutation").not.toHaveBeenCalled();
    expect(lostDuringPreparation.lifecycle.dismiss, "abandoned preparation dismisses").toHaveBeenCalledOnce();
    expect(lostDuringPreparation.controller.isActive(), "abandoned preparation deactivates").toBe(false);

    const eligibility = deferred();
    const threadDuringRead = fixture({
      lifecycle: lifecycle({ read: vi.fn(() => eligibility.promise) }),
    });
    const readAbandoned = threadDuringRead.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    threadDuringRead.appState.threads.push({ id: 7 });
    eligibility.resolve({ automaticEligible: true, status: "never-shown" });
    await expect(readAbandoned, "a new thread during the eligibility read aborts the start").resolves.toBe(false);
    expect(threadDuringRead.lifecycle.beginAutomatic, "thread during read prevents begin").not.toHaveBeenCalled();
    expect(threadDuringRead.openNewThread, "thread during read prevents composer launch").not.toHaveBeenCalled();
    expect(threadDuringRead.controller.isActive(), "thread during read stays inactive").toBe(false);

    const beginAutomaticInterruption = deferred();
    const threadDuringBegin = fixture({
      lifecycle: lifecycle({ beginAutomatic: vi.fn(() => beginAutomaticInterruption.promise) }),
    });
    const beginAutomaticAbandoned = threadDuringBegin.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(threadDuringBegin.lifecycle.beginAutomatic, "automatic begin started").toHaveBeenCalledOnce());
    threadDuringBegin.appState.threads.push({ id: 7 });
    beginAutomaticInterruption.resolve({ started: true, source: "automatic" });
    await expect(beginAutomaticAbandoned, "a new thread during begin aborts the start").resolves.toBe(false);
    expect(threadDuringBegin.lifecycle.dismiss, "thread during begin dismisses").toHaveBeenCalledOnce();
    expect(threadDuringBegin.openNewThread, "thread during begin prevents composer launch").not.toHaveBeenCalled();
    expect(threadDuringBegin.controller.isActive(), "thread during begin deactivates").toBe(false);
    expect(threadDuringBegin.controller.snapshot(), "thread during begin leaves no snapshot").toBeNull();
    expect(coachmark(threadDuringBegin), "thread during begin leaves no coach").toBeUndefined();

    const preparationAutomatic = deferred();
    const automaticMutation = vi.fn();
    const automaticOpenNewThread = vi.fn(async ({ guard }) => {
      await preparationAutomatic.promise;
      if (!guard()) return false;
      automaticMutation();
      return true;
    });
    const threadDuringPreparation = fixture({ openNewThread: automaticOpenNewThread });
    const preparationAutomaticAbandoned = threadDuringPreparation.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(automaticOpenNewThread, "automatic preparation started").toHaveBeenCalledOnce());
    expect(threadDuringPreparation.controller.isActive(), "preparation owns nothing until it lands").toBe(false);
    threadDuringPreparation.appState.threads.push({ id: 7 });
    preparationAutomatic.resolve();
    await expect(preparationAutomaticAbandoned, "a new thread during preparation aborts the start").resolves.toBe(false);
    expect(automaticMutation, "new thread guards the composer mutation boundary").not.toHaveBeenCalled();
    expect(threadDuringPreparation.lifecycle.dismiss, "thread during preparation dismisses").toHaveBeenCalledOnce();
    expect(threadDuringPreparation.controller.isActive(), "thread during preparation deactivates").toBe(false);
    expect(threadDuringPreparation.controller.snapshot(), "thread during preparation leaves no snapshot").toBeNull();
    expect(coachmark(threadDuringPreparation), "thread during preparation leaves no coach").toBeUndefined();
  }, 15_000);

  it("arbitrates pending-start ownership between manual, automatic, and takeover paths", async () => {
    const automaticBegin = deferred();
    const manualBegin = deferred();
    const superseded = fixture({
      lifecycle: lifecycle({
        beginAutomatic: vi.fn(() => automaticBegin.promise),
        beginManual: vi.fn(() => manualBegin.promise),
      }),
    });
    const automaticStart = superseded.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(superseded.lifecycle.beginAutomatic, "automatic begin pending").toHaveBeenCalledOnce());
    const manualStart = superseded.controller.startManual();
    await vi.waitFor(() => expect(superseded.lifecycle.beginManual, "manual begin pending").toHaveBeenCalledOnce());

    automaticBegin.resolve({ started: true, source: "automatic" });
    await expect(automaticStart, "manual start supersedes the pending automatic start").resolves.toBe(false);
    expect(superseded.openNewThread, "superseded automatic start never opens the composer").not.toHaveBeenCalled();

    manualBegin.resolve({ started: true, source: "manual" });
    await expect(manualStart, "superseding manual start completes").resolves.toBe(true);
    expect(superseded.openNewThread, "manual start opens the composer once").toHaveBeenCalledOnce();
    expect(superseded.openNewThread).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Why can time seem to pass faster as we get older?",
      source: "manual",
      guard: expect.any(Function),
    }));
    expect(superseded.controller.isActive(), "manual start wins ownership").toBe(true);
    expect(superseded.controller.snapshot(), "manual start reaches the composer phase").toMatchObject({ phase: "initial-composer" });

    const manualOnlyBegin = deferred();
    const probedManual = fixture({
      lifecycle: lifecycle({ beginManual: vi.fn(() => manualOnlyBegin.promise) }),
    });
    const pendingManual = probedManual.controller.startManual();
    await vi.waitFor(() => expect(probedManual.lifecycle.beginManual, "manual begin pending for probe").toHaveBeenCalledOnce());
    await expect(probedManual.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    }), "automatic probe cannot supersede a pending manual start").resolves.toBe(false);
    manualOnlyBegin.resolve({ started: true, source: "manual" });
    await expect(pendingManual, "pending manual start survives the probe").resolves.toBe(true);
    expect(probedManual.lifecycle.read, "probe skips the eligibility read").not.toHaveBeenCalled();
    expect(probedManual.lifecycle.beginAutomatic, "probe skips automatic begin").not.toHaveBeenCalled();
    expect(probedManual.openNewThread, "manual start opens the composer once").toHaveBeenCalledOnce();
    expect(probedManual.openNewThread).toHaveBeenCalledWith(expect.objectContaining({
      source: "manual",
      guard: expect.any(Function),
    }));
    expect(probedManual.controller.isActive(), "manual start keeps ownership").toBe(true);
    expect(probedManual.controller.snapshot(), "manual start reaches the composer phase").toMatchObject({ phase: "initial-composer" });

    const doubleBegin = deferred();
    const probedAutomatic = fixture({
      lifecycle: lifecycle({ beginAutomatic: vi.fn(() => doubleBegin.promise) }),
    });
    const firstAutomatic = probedAutomatic.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(probedAutomatic.lifecycle.beginAutomatic, "first automatic begin pending").toHaveBeenCalledOnce());
    await expect(probedAutomatic.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    }), "second automatic probe cannot supersede the first").resolves.toBe(false);
    expect(probedAutomatic.lifecycle.read, "second probe skips the eligibility read").toHaveBeenCalledOnce();
    expect(probedAutomatic.lifecycle.beginAutomatic, "second probe skips begin").toHaveBeenCalledOnce();
    doubleBegin.resolve({ started: true, source: "automatic" });
    await expect(firstAutomatic, "first automatic start survives the probe").resolves.toBe(true);
    expect(probedAutomatic.openNewThread, "automatic start opens the composer once").toHaveBeenCalledOnce();
    expect(probedAutomatic.openNewThread).toHaveBeenCalledWith(expect.objectContaining({
      source: "automatic",
      guard: expect.any(Function),
    }));
    expect(probedAutomatic.controller.isActive(), "automatic start keeps ownership").toBe(true);
    expect(probedAutomatic.controller.snapshot(), "automatic start reaches the composer phase").toMatchObject({ phase: "initial-composer" });

    const takeoverBegin = deferred();
    const dismiss = vi.fn()
      .mockResolvedValueOnce({ status: "dismissed" })
      .mockRejectedValueOnce(new Error("redundant cleanup must not run"));
    const settingsTakeover = fixture({
      lifecycle: lifecycle({
        beginAutomatic: vi.fn(() => takeoverBegin.promise),
        dismiss,
      }),
    });
    const revokedStart = settingsTakeover.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(settingsTakeover.lifecycle.beginAutomatic, "takeover-target begin pending").toHaveBeenCalledOnce());
    expect(settingsTakeover.controller.cancelPendingAutomatic(), "Settings takeover revokes the pending start").toBe(true);
    await vi.waitFor(() => expect(settingsTakeover.lifecycle.dismiss, "takeover dismisses once").toHaveBeenCalledOnce());
    takeoverBegin.resolve({ started: true, source: "automatic" });
    await expect(revokedStart, "revoked automatic start lands inactive").resolves.toBe(false);
    expect(settingsTakeover.lifecycle.dismiss, "takeover never runs redundant cleanup").toHaveBeenCalledOnce();
    expect(settingsTakeover.openNewThread, "revoked start never opens the composer").not.toHaveBeenCalled();
    expect(settingsTakeover.controller.isActive(), "revoked start deactivates").toBe(false);

    const takeoverPreparation = deferred();
    const takeoverMutation = vi.fn();
    const takeoverOpenNewThread = vi.fn(async ({ guard }) => {
      await takeoverPreparation.promise;
      if (!guard()) return false;
      takeoverMutation();
      return true;
    });
    const promptTakeover = fixture({ openNewThread: takeoverOpenNewThread });
    const guardedStart = promptTakeover.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    });
    await vi.waitFor(() => expect(takeoverOpenNewThread, "takeover-target preparation pending").toHaveBeenCalledOnce());
    expect(promptTakeover.controller.cancelPendingAutomatic(), "prompt typing takeover revokes preparation").toBe(true);
    takeoverPreparation.resolve();
    await expect(guardedStart, "takeover revokes the automatic preparation").resolves.toBe(false);
    expect(takeoverMutation, "takeover guards the composer mutation").not.toHaveBeenCalled();
    expect(promptTakeover.controller.isActive(), "takeover deactivates").toBe(false);

    const protectedManualBegin = deferred();
    const protectedManual = fixture({
      lifecycle: lifecycle({ beginManual: vi.fn(() => protectedManualBegin.promise) }),
    });
    const protectedStart = protectedManual.controller.startManual();
    await vi.waitFor(() => expect(protectedManual.lifecycle.beginManual, "protected manual begin pending").toHaveBeenCalledOnce());
    expect(protectedManual.controller.cancelPendingAutomatic(), "takeover cancellation ignores manual ownership").toBe(false);
    expect(protectedManual.lifecycle.dismiss, "takeover cancellation never dismisses manual").not.toHaveBeenCalled();
    protectedManualBegin.resolve({ started: true, source: "manual" });
    await expect(protectedStart, "manual start survives takeover cancellation").resolves.toBe(true);
    expect(protectedManual.openNewThread, "manual start opens the composer once").toHaveBeenCalledOnce();
    expect(protectedManual.controller.isActive(), "manual start keeps ownership").toBe(true);
  }, 15_000);

  it("terminates safely through every failure and disqualification path", async () => {
    const readFailure = fixture({
      lifecycle: lifecycle({
        read: vi.fn()
          .mockRejectedValueOnce(new Error("settings read failed"))
          .mockResolvedValue({ automaticEligible: true, status: "never-shown" }),
      }),
    });
    await expect(readFailure.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    }), "eligibility read failure surfaces").rejects.toThrow("settings read failed");
    await expect(readFailure.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    }), "read failure releases automatic ownership").resolves.toBe(true);
    expect(readFailure.lifecycle.read, "read retried after failure").toHaveBeenCalledTimes(2);
    expect(readFailure.lifecycle.beginAutomatic, "recovered start begins once").toHaveBeenCalledOnce();
    expect(readFailure.openNewThread, "recovered start opens the composer").toHaveBeenCalledOnce();

    const beginFailure = fixture({
      lifecycle: lifecycle({
        beginAutomatic: vi.fn()
          .mockRejectedValueOnce(new Error("automatic begin failed"))
          .mockResolvedValue({ started: true, source: "automatic" }),
        dismiss: vi.fn(async () => { throw new Error("cleanup failed"); }),
      }),
    });
    await expect(beginFailure.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    }), "automatic begin failure surfaces").rejects.toThrow("automatic begin failed");
    await expect(beginFailure.controller.maybeStartAutomatic({
      providerConnected: true,
      threadCount: 0,
    }), "begin failure releases automatic ownership").resolves.toBe(true);
    expect(beginFailure.lifecycle.beginAutomatic, "begin retried after failure").toHaveBeenCalledTimes(2);
    expect(beginFailure.lifecycle.dismiss, "failed begin cleans up despite cleanup errors").toHaveBeenCalledOnce();
    expect(beginFailure.openNewThread, "recovered begin opens the composer").toHaveBeenCalledOnce();

    const manualFailure = fixture({
      lifecycle: lifecycle({
        beginManual: vi.fn()
          .mockRejectedValueOnce(new Error("manual begin failed"))
          .mockResolvedValue({ started: true, source: "manual" }),
        dismiss: vi.fn(async () => { throw new Error("cleanup failed"); }),
      }),
    });
    await expect(manualFailure.controller.startManual(), "manual begin failure surfaces")
      .rejects.toThrow("manual begin failed");
    await expect(manualFailure.controller.startManual(), "manual begin failure releases ownership")
      .resolves.toBe(true);
    expect(manualFailure.lifecycle.beginManual, "manual begin retried after failure").toHaveBeenCalledTimes(2);
    expect(manualFailure.lifecycle.dismiss, "failed manual begin cleans up despite cleanup errors").toHaveBeenCalledOnce();
    expect(manualFailure.openNewThread, "recovered manual begin opens the composer").toHaveBeenCalledOnce();

    const leaveRevocation = deferred();
    const leaver = fixture({
      lifecycle: lifecycle({ beginManual: vi.fn(() => leaveRevocation.promise) }),
    });
    const revokedByLeave = leaver.controller.startManual();
    await vi.waitFor(() => expect(leaver.lifecycle.beginManual, "leave-target begin pending").toHaveBeenCalledOnce());
    await leaver.controller.leave();
    leaveRevocation.resolve({ started: true, source: "manual" });
    await expect(revokedByLeave, "leaving revokes a pending begin").resolves.toBe(false);
    expect(leaver.lifecycle.dismiss, "leave dismisses the revoked begin").toHaveBeenCalledOnce();
    expect(leaver.openNewThread, "revoked begin never opens the composer").not.toHaveBeenCalled();
    expect(leaver.controller.isActive(), "leave deactivates").toBe(false);
    expect(leaver.controller.snapshot(), "leave clears the snapshot").toBeNull();

    const composerOpenFailure = vi.fn()
      .mockRejectedValueOnce(new Error("composer failed"))
      .mockResolvedValue(true);
    const failedSurface = fixture({
      lifecycle: lifecycle({ dismiss: vi.fn(async () => { throw new Error("cleanup failed"); }) }),
      openNewThread: composerOpenFailure,
    });
    await expect(failedSurface.controller.startManual(), "composer open failure surfaces")
      .rejects.toThrow("composer failed");
    expect(failedSurface.lifecycle.dismiss, "failed surface cleans up its lifecycle").toHaveBeenCalledOnce();
    expect(failedSurface.controller.isActive(), "failed surface deactivates").toBe(false);
    expect(failedSurface.controller.snapshot(), "failed surface clears the snapshot").toBeNull();
    expect(coachmark(failedSurface), "failed surface leaves no coach").toBeUndefined();
    await expect(failedSurface.controller.startManual(), "manual start recovers after a surface failure")
      .resolves.toBe(true);
    expect(composerOpenFailure, "recovery retries the composer").toHaveBeenCalledTimes(2);
    expect(failedSurface.controller.isActive(), "recovery activates").toBe(true);

    const dismissFailure = fixture({
      lifecycle: lifecycle({ dismiss: vi.fn(async () => { throw new Error("disk failed"); }) }),
    });
    await dismissFailure.controller.startManual();
    await expect(dismissFailure.controller.skip(), "dismissal persistence failure surfaces")
      .rejects.toThrow("disk failed");
    expect(dismissFailure.controller.isActive(), "failed dismissal still deactivates").toBe(false);
    expect(dismissFailure.controller.snapshot(), "failed dismissal clears the snapshot").toBeNull();
    expect(dismissFailure.newComposer.classList.contains("tutorial-target"), "failed dismissal releases the target").toBe(false);
    expect(coachmark(dismissFailure), "failed dismissal removes the coach UI").toBeUndefined();

    for (const [label, interaction, reason] of [
      ["a response without actions", acceptedInteraction({ actions: [] }), "no-action"],
      ["a failed response", { id: 11, threadId: 7, completionStatus: "failed" }, "response-failed"],
    ]) {
      const disqualified = fixture();
      await startAndCreateThread(disqualified);
      disqualified.appState.interactions = [interaction];
      disqualified.controller.syncWorkspace();

      expect(disqualified.controller.isActive(), `${label}: tutorial hides`).toBe(false);
      expect(disqualified.controller.snapshot(), `${label}: snapshot cleared`).toBeNull();
      expect(coachmark(disqualified), `${label}: coach removed`).toBeUndefined();
      await vi.waitFor(() => expect(disqualified.lifecycle.dismiss, `${label}: dismissal persisted`).toHaveBeenCalledOnce());
      expect(reason, `${label}: dismissal reason in the documented vocabulary`).toMatch(/^(no-action|response-failed)$/);
    }

    const leftThread = fixture();
    await startAndCreateThread(leftThread);
    leftThread.viewState.currentThreadId = 8;
    leftThread.controller.presentationChanged();
    await vi.waitFor(() => expect(leftThread.lifecycle.dismiss, "leaving the tutorial thread dismisses").toHaveBeenCalledOnce());
    expect(leftThread.controller.isActive(), "leaving the tutorial thread deactivates").toBe(false);

    const changedInteraction = fixture();
    await startAndCreateThread(changedInteraction);
    changedInteraction.viewState.currentInteractionId = 12;
    changedInteraction.controller.syncWorkspace();
    await vi.waitFor(() => expect(changedInteraction.lifecycle.dismiss, "a visible foreign interaction dismisses").toHaveBeenCalledOnce());
    expect(changedInteraction.controller.isActive(), "a visible foreign interaction deactivates").toBe(false);

    const hydrating = fixture();
    await hydrating.controller.startManual();
    hydrating.controller.threadCreated({ threadId: 7, interactionId: 11 });
    hydrating.viewState.mainView = "thread";
    hydrating.viewState.currentThreadId = 7;
    hydrating.viewState.currentInteractionId = null;
    hydrating.controller.presentationChanged();
    expect(hydrating.controller.isActive(), "unhydrated tutorial interaction tolerated during load").toBe(true);
    expect(hydrating.controller.snapshot(), "unhydrated interaction keeps awaiting the response").toMatchObject({
      phase: "awaiting-accepted-response",
      interactionId: 11,
    });

    const disconnecting = fixture();
    await disconnecting.controller.startManual();
    await disconnecting.controller.leave();
    expect(disconnecting.lifecycle.dismiss, "provider disconnect dismisses explicitly").toHaveBeenCalledOnce();
    expect(disconnecting.controller.isActive(), "provider disconnect deactivates").toBe(false);
  }, 15_000);

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
    expect(main).toContain("async function openNewThreadComposer({");
    expect(main).toContain('scope = { kind: "standalone", label: "No folder" },');
    expect(main).toContain("guard = null,");
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
    expect(main).toContain("if (pendingNewThreadDraft()?.text) return false;");
    expect(main).toContain("PROJECT_COMPOSER_DESTINATION_SELECTOR");
    expect(graph).toContain(`onSelectTurn: (delta) => {
      projectComposerGate.invalidate();`);
    expect(graph).toContain(`onSelectTurnById: (turnId) => {
      projectComposerGate.invalidate();`);
    expect(threads.indexOf("const submission = projectComposerGate.begin();"))
      .toBeLessThan(threads.indexOf('creatingFirstThread = true;'));
    expect(threads).toContain("if (!submissionIsCurrent()) return;");
    expect(main.indexOf('$("#newThreadPrompt").value = resolvedPrompt;'))
      .toBeLessThan(main.indexOf("persistPendingNewThreadDraft(resolvedPrompt, scope);"));
    expect(main.match(/takeOverPendingAutomaticTutorial\(\);/g)).toHaveLength(6);
    expect(main).toContain(`$("#newThreadPrompt").oninput = () => {
    takeOverPendingAutomaticTutorial();`);
    expect(main).toContain(`$("#settingsButton").onclick = async () => {
    projectComposerGate.invalidate();
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

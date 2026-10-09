import { afterEach, describe, expect, it, vi } from "vitest";

import { RelayerGraphClient } from "@relayer/graph-client";
import {
  RECURSIVE_FIXTURE_CHILD_TASK,
  recursiveCompleteFixtureFactory,
} from "./support/recursive-complete-fixture.mjs";

const originalMethods = new Map();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlesAfterTurns(promise) {
  let outcome;
  promise.then((value) => { outcome = value; });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  return outcome;
}

function controlledChild(advanceCurrent) {
  const enteredAdvance = deferred();
  for (const [name, implementation] of Object.entries({
    getCurrent: async () => ({ headRevision: 1 }),
    getContract: async () => undefined,
    submitNode: async () => undefined,
    submitLayer: async () => undefined,
    addAction: async () => undefined,
    advanceCurrent: (...args) => {
      enteredAdvance.resolve();
      return advanceCurrent(...args);
    },
  })) {
    originalMethods.set(name, RelayerGraphClient.prototype[name]);
    vi.spyOn(RelayerGraphClient.prototype, name).mockImplementation(implementation);
  }

  const controller = new AbortController();
  const observed = { childBlocks: true };
  const handle = recursiveCompleteFixtureFactory(observed)().complete({
    inputGraph: { id: 1, detail: RECURSIVE_FIXTURE_CHILD_TASK },
    graph: { acquireCapability: () => ({ url: "http://unused", token: "fixture", nodeId: 1 }) },
  }, controller.signal);
  return { controller, enteredAdvance, handle, observed };
}

function controlledParent({ childStart, childAdvance, failChildStart = false, parentSignal }) {
  let currentReads = 0;
  let currentAdvances = 0;
  const childAdvanceEntered = deferred();
  const childCompletionCreated = deferred();
  const stopCalls = [];
  let childHandle;
  let childNativeSettled;
  const observed = { childBlocks: true };

  const methods = {
    getCurrent: async () => ({ headRevision: currentReads++ === 0 ? 0 : 1 }),
    getContract: async () => undefined,
    submitNode: async () => undefined,
    submitLayer: async () => undefined,
    addAction: async (_source, action) => action.kind === "invoke" ? { id: 3 } : undefined,
    advanceCurrent: async () => {
      if (currentAdvances++ === 0) return { revision: 1 };
      childAdvanceEntered.resolve();
      return childAdvance.promise;
    },
    prepareComplete: async () => ({ interactionNode: 2 }),
    returnCurrent: async () => undefined,
  };
  for (const [name, implementation] of Object.entries(methods)) {
    originalMethods.set(name, RelayerGraphClient.prototype[name]);
    vi.spyOn(RelayerGraphClient.prototype, name).mockImplementation(implementation);
  }

  let harness;
  const completeChild = () => {
    const childResult = deferred();
    void childResult.promise.catch(() => undefined);
    const controller = new AbortController();
    childHandle = {
      completionId: 2,
      result: childResult.promise,
      stop: async () => {
        stopCalls.push("stop");
        controller.abort();
        await childNativeSettled;
        childResult.reject(new Error("child was stopped"));
      },
      current: { snapshot: async () => ({ lifecycle: "stopped", revision: 2 }) },
    };
    childCompletionCreated.resolve();
    if (failChildStart) {
      childStart.promise.then(() => childResult.reject(new Error("child startup failed")));
    } else {
      childStart.promise.then(() => {
        const execution = harness.complete({
          inputGraph: { id: 2, detail: RECURSIVE_FIXTURE_CHILD_TASK },
          graph: { acquireCapability: () => ({ url: "http://unused", token: "fixture", nodeId: 2 }) },
        }, controller.signal);
        childNativeSettled = execution.settled;
        void execution.settled.then((outcome) => {
          if (outcome.status === "failed") childResult.reject(new Error("child execution failed"));
        });
      });
    }
    return childHandle;
  };

  harness = recursiveCompleteFixtureFactory(observed, () => "http://unused", completeChild)();
  const parent = harness.complete({
    inputGraph: { id: 1, detail: "Parent task" },
    completionBroker: { token: "fixture" },
    graph: { acquireCapability: () => ({ url: "http://unused", token: "fixture", nodeId: 1 }) },
  }, parentSignal);
  return {
    childAdvanceEntered,
    childCompletionCreated,
    childHandle: () => childHandle,
    observed,
    parent,
    stopCalls,
  };
}

function controlledRig({ routes, failingStarts = [], failingAdvances = [], onChildCreated }) {
  const childIds = new Set([...routes.values()]);
  const parentToChild = new Map(routes);
  const childStarts = new Map([...childIds].map((id) => [id, deferred()]));
  const childAdvances = new Map([...childIds].map((id) => [id, deferred()]));
  const childAdvanceEntered = new Map([...childIds].map((id) => [id, deferred()]));
  const stopCalls = [];
  const createdChildIds = [];
  const childCompletionCreated = new Map([...childIds].map((id) => [id, deferred()]));
  const harnessByChild = new Map();
  const observed = { childBlocks: true };

  for (const [name, implementation] of Object.entries({
    getCurrent: async function () {
      return { headRevision: childIds.has(this.capability.nodeId) ? 1 : 0 };
    },
    getContract: async () => undefined,
    submitNode: async () => undefined,
    submitLayer: async () => undefined,
    addAction: async function (_source, action) {
      return action.kind === "invoke" ? { id: parentToChild.get(this.capability.nodeId) } : undefined;
    },
    advanceCurrent: async function () {
      const nodeId = this.capability.nodeId;
      if (!childIds.has(nodeId)) return { revision: 1 };
      childAdvanceEntered.get(nodeId).resolve();
      if (failingAdvances.includes(nodeId)) return Promise.reject(new Error(`child ${nodeId} advance failed`));
      return childAdvances.get(nodeId).promise;
    },
    prepareComplete: async function () { return { interactionNode: parentToChild.get(this.capability.nodeId) }; },
    returnCurrent: async function () { observed.returnedParents = [...(observed.returnedParents ?? []), this.capability.nodeId]; },
  })) {
    originalMethods.set(name, RelayerGraphClient.prototype[name]);
    vi.spyOn(RelayerGraphClient.prototype, name).mockImplementation(implementation);
  }

  let harness;
  const completeChild = (inputGraph) => {
    const childId = inputGraph.interactionNode;
    createdChildIds.push(childId);
    const childResult = deferred();
    void childResult.promise.catch(() => undefined);
    const controller = new AbortController();
    const created = childCompletionCreated.get(childId);
    const handle = {
      completionId: childId,
      result: childResult.promise,
      stop: async () => {
        stopCalls.push(childId);
        controller.abort();
        await handle.nativeSettled;
        childResult.reject(new Error(`child ${childId} was stopped`));
      },
      current: { snapshot: async () => ({ lifecycle: "stopped", revision: childId }) },
    };
    created.resolve();
    onChildCreated?.(childId);
    childStarts.get(childId).promise.then(async () => {
      if (failingStarts.includes(childId)) {
        childResult.reject(new Error(`child ${childId} startup failed`));
        return;
      }
      const execution = harnessByChild.get(childId).complete({
        inputGraph: { id: childId, detail: RECURSIVE_FIXTURE_CHILD_TASK },
        graph: { acquireCapability: () => ({ url: "http://unused", token: "fixture", nodeId: childId }) },
      }, controller.signal);
      handle.nativeSettled = execution.settled;
      void execution.settled.then((outcome) => {
        if (outcome.status === "failed") childResult.reject(new Error(`child ${childId} execution failed`));
      });
    });
    return handle;
  };

  const fixtureFactory = recursiveCompleteFixtureFactory(observed, () => "http://unused", completeChild);
  const createHarness = (parentIds = [...routes.keys()]) => {
    harness = fixtureFactory();
    for (const parentId of parentIds) harnessByChild.set(parentToChild.get(parentId), harness);
    return harness;
  };
  const startParent = (
    parentId,
    selectedHarness = harness ?? createHarness(),
    signal,
  ) => selectedHarness.complete({
    inputGraph: { id: parentId, detail: "Parent task" },
    completionBroker: { token: "fixture" },
    graph: { acquireCapability: () => ({ url: "http://unused", token: "fixture", nodeId: parentId }) },
  }, signal);

  return {
    childAdvanceEntered,
    childAdvances,
    childCompletionCreated,
    childStarts,
    createHarness,
    createdChildIds,
    observed,
    startParent,
    stopCalls,
  };
}

function replacementGateRig() {
  const childStarts = new Map([[1, deferred()], [3, deferred()]]);
  const childAdvances = new Map([[1, deferred()], [3, deferred()]]);
  const childAdvanceEntered = new Map([[1, deferred()], [3, deferred()]]);
  const childCompletionCreated = new Map([[1, deferred()], [3, deferred()]]);
  const stopCalls = [];
  const observed = { childBlocks: true };

  for (const [name, implementation] of Object.entries({
    getCurrent: async function () {
      return { headRevision: this.capability.fixtureParentId === undefined ? 0 : 1 };
    },
    getContract: async () => undefined,
    submitNode: async () => undefined,
    submitLayer: async () => undefined,
    addAction: async (_source, action) => action.kind === "invoke" ? { id: 2 } : undefined,
    advanceCurrent: async function () {
      const parentId = this.capability.fixtureParentId;
      if (parentId === undefined) return { revision: 1 };
      childAdvanceEntered.get(parentId).resolve();
      return childAdvances.get(parentId).promise;
    },
    prepareComplete: async function () {
      return { interactionNode: 2, fixtureParentId: this.capability.nodeId };
    },
    returnCurrent: async () => undefined,
  })) {
    originalMethods.set(name, RelayerGraphClient.prototype[name]);
    vi.spyOn(RelayerGraphClient.prototype, name).mockImplementation(implementation);
  }

  let harness;
  let secondParent;
  let registeredReplacement = false;
  const completeChild = (inputGraph) => {
    const parentId = inputGraph.fixtureParentId;
    const result = deferred();
    void result.promise.catch(() => undefined);
    const controller = new AbortController();
    const handle = {
      completionId: 2,
      result: result.promise,
      stop: async () => {
        stopCalls.push(parentId);
        controller.abort();
        await handle.nativeSettled;
        result.reject(new Error(`child for parent ${parentId} was stopped`));
      },
      current: { snapshot: async () => ({ lifecycle: "stopped", parentId }) },
    };
    childCompletionCreated.get(parentId).resolve();
    childStarts.get(parentId).promise.then(() => {
      const execution = harness.complete({
        inputGraph: { id: 2, detail: RECURSIVE_FIXTURE_CHILD_TASK },
        graph: {
          acquireCapability: () => ({
            url: "http://unused", token: "fixture", nodeId: 2, fixtureParentId: parentId,
          }),
        },
      }, controller.signal);
      handle.nativeSettled = execution.settled;
      void execution.settled.then((outcome) => {
        if (outcome.status === "failed") result.reject(new Error(`child for parent ${parentId} execution failed`));
      });
    });
    return handle;
  };

  observed.afterChildPublication = async (context) => {
    if (registeredReplacement || context.graph.acquireCapability().fixtureParentId !== 1) return;
    registeredReplacement = true;
    secondParent = harness.complete({
      inputGraph: { id: 3, detail: "Parent task" },
      completionBroker: { token: "fixture" },
      graph: { acquireCapability: () => ({ url: "http://unused", token: "fixture", nodeId: 3 }) },
    });
    await childCompletionCreated.get(3).promise;
  };
  harness = recursiveCompleteFixtureFactory(observed, () => "http://unused", completeChild)();
  const firstParent = harness.complete({
    inputGraph: { id: 1, detail: "Parent task" },
    completionBroker: { token: "fixture" },
    graph: { acquireCapability: () => ({ url: "http://unused", token: "fixture", nodeId: 1 }) },
  });

  return {
    childAdvanceEntered,
    childAdvances,
    childCompletionCreated,
    childStarts,
    firstParent,
    secondParent: () => secondParent,
    stopCalls,
  };
}

afterEach(() => {
  for (const [name, implementation] of originalMethods) {
    RelayerGraphClient.prototype[name] = implementation;
  }
  originalMethods.clear();
  vi.restoreAllMocks();
});

describe("recursive fixture cancellation readiness", () => {
  it("settles when abort arrives before the advance response", async () => {
    const advanceResponse = deferred();
    const child = controlledChild(() => advanceResponse.promise);

    await child.enteredAdvance.promise;
    child.controller.abort();
    advanceResponse.resolve();

    expect(await settlesAfterTurns(child.handle.settled)).toMatchObject({ status: "failed" });
  });

  it("keeps the child pending after installing cancellation until abort", async () => {
    const advanceResponse = deferred();
    const child = controlledChild(() => advanceResponse.promise);

    await child.enteredAdvance.promise;
    advanceResponse.resolve();
    await new Promise(setImmediate);
    child.controller.abort();
    expect(await settlesAfterTurns(child.handle.settled)).toMatchObject({ status: "failed" });
  });

  it("fails child execution when current publication fails", async () => {
    const setupFailure = new Error("advance failed");
    const child = controlledChild(() => Promise.reject(setupFailure));

    await child.enteredAdvance.promise;
    expect(await settlesAfterTurns(child.handle.settled)).toMatchObject({ status: "failed" });
  });

  it("parent waits through delayed child startup and publication before stopping", async () => {
    const childStart = deferred();
    const childAdvance = deferred();
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const parent = controlledParent({
      childStart,
      childAdvance,
      parentSignal: controller.signal,
    });

    await parent.childCompletionCreated.promise;
    expect(await settlesAfterTurns(parent.parent.settled)).toBeUndefined();
    expect(parent.stopCalls).toEqual([]);

    childStart.resolve();
    await parent.childAdvanceEntered.promise;
    expect(await settlesAfterTurns(parent.parent.settled)).toBeUndefined();
    expect(parent.stopCalls).toEqual([]);

    childAdvance.resolve({ revision: 2 });
    await expect(parent.parent.settled).resolves.toMatchObject({ status: "exited" });
    expect(parent.stopCalls).toEqual(["stop"]);
    expect(parent.observed.stoppedChild).toMatchObject({ lifecycle: "stopped", revision: 2 });
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("parent fails promptly when child startup fails before readiness", async () => {
    const childStart = deferred();
    const childAdvance = deferred();
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const parent = controlledParent({
      childStart,
      childAdvance,
      failChildStart: true,
      parentSignal: controller.signal,
    });

    await parent.childCompletionCreated.promise;
    childStart.resolve();
    await expect(parent.parent.settled).resolves.toMatchObject({ status: "failed" });
    expect(parent.stopCalls).toEqual([]);
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not start an independent child when the parent is already aborted", async () => {
    const rig = controlledRig({ routes: new Map([[1, 2]]) });
    const controller = new AbortController();
    controller.abort();

    const parent = rig.startParent(1, rig.createHarness(), controller.signal);

    await expect(parent.settled).resolves.toMatchObject({ status: "failed" });
    expect(rig.createdChildIds).toEqual([]);
    expect(rig.stopCalls).toEqual([]);
  });

  it("settles a parent aborted during readiness without stopping its child or sibling", async () => {
    const rig = controlledRig({
      routes: new Map([[1, 2], [3, 4]]),
      failingAdvances: [2],
    });
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const harness = rig.createHarness();
    const parent = rig.startParent(1, harness, controller.signal);
    const sibling = rig.startParent(3, harness);
    await Promise.all([
      rig.childCompletionCreated.get(2).promise,
      rig.childCompletionCreated.get(4).promise,
    ]);

    controller.abort();

    await expect(parent.settled).resolves.toMatchObject({ status: "failed" });
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(rig.createdChildIds).toEqual([2, 4]);
    expect(rig.stopCalls).toEqual([]);

    rig.childStarts.get(2).resolve();
    await rig.childAdvanceEntered.get(2).promise;
    await new Promise(setImmediate);

    rig.childStarts.get(4).resolve();
    await rig.childAdvanceEntered.get(4).promise;
    rig.childAdvances.get(4).resolve({ revision: 2 });
    await expect(sibling.settled).resolves.toMatchObject({ status: "exited" });
    expect(rig.stopCalls).toEqual([4]);
  });

  it("observes a child rejection after launch synchronously aborts its parent", async () => {
    const controller = new AbortController();
    const rig = controlledRig({
      routes: new Map([[1, 2]]),
      failingStarts: [2],
      onChildCreated: () => controller.abort(),
    });
    const parent = rig.startParent(1, rig.createHarness(), controller.signal);

    await expect(parent.settled).resolves.toMatchObject({ status: "failed" });
    rig.childStarts.get(2).resolve();
    await new Promise(setImmediate);
    expect(rig.stopCalls).toEqual([]);
  });

  it("does not stop a child when readiness and parent abort happen in the same turn", async () => {
    const rig = controlledRig({ routes: new Map([[1, 2]]) });
    const controller = new AbortController();
    const removeAbortListener = controller.signal.removeEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation((...args) => {
      removeAbortListener(...args);
      controller.abort();
    });
    const parent = rig.startParent(1, rig.createHarness(), controller.signal);
    await rig.childCompletionCreated.get(2).promise;
    rig.childStarts.get(2).resolve();
    await rig.childAdvanceEntered.get(2).promise;

    rig.childAdvances.get(2).resolve({ revision: 2 });

    await expect(parent.settled).resolves.toMatchObject({ status: "failed" });
    expect(rig.stopCalls).toEqual([]);
  });

  it("uses a fresh readiness gate for a second parent on the same harness", async () => {
    const rig = controlledRig({ routes: new Map([[1, 2], [3, 4]]) });
    const harness = rig.createHarness();
    const first = rig.startParent(1, harness);
    await rig.childCompletionCreated.get(2).promise;
    rig.childStarts.get(2).resolve();
    await rig.childAdvanceEntered.get(2).promise;
    rig.childAdvances.get(2).resolve({ revision: 2 });
    await expect(first.settled).resolves.toMatchObject({ status: "exited" });
    expect(rig.stopCalls).toEqual([2]);

    const second = rig.startParent(3, harness);
    await rig.childCompletionCreated.get(4).promise;
    expect(await settlesAfterTurns(second.settled)).toBeUndefined();
    expect(rig.stopCalls).toEqual([2]);

    rig.childStarts.get(4).resolve();
    await rig.childAdvanceEntered.get(4).promise;
    expect(await settlesAfterTurns(second.settled)).toBeUndefined();
    rig.childAdvances.get(4).resolve({ revision: 2 });
    await expect(second.settled).resolves.toMatchObject({ status: "exited" });
    expect(rig.stopCalls).toEqual([2, 4]);
  });

  it("does not let a failed child poison the next parent on the same harness", async () => {
    const rig = controlledRig({ routes: new Map([[1, 2], [3, 4]]), failingAdvances: [2] });
    const harness = rig.createHarness();
    const failed = rig.startParent(1, harness);
    await rig.childCompletionCreated.get(2).promise;
    rig.childStarts.get(2).resolve();
    await rig.childAdvanceEntered.get(2).promise;
    await expect(failed.settled).resolves.toMatchObject({ status: "failed" });

    const next = rig.startParent(3, harness);
    await rig.childCompletionCreated.get(4).promise;
    expect(await settlesAfterTurns(next.settled)).toBeUndefined();
    rig.childStarts.get(4).resolve();
    await rig.childAdvanceEntered.get(4).promise;
    rig.childAdvances.get(4).resolve({ revision: 2 });
    await expect(next.settled).resolves.toMatchObject({ status: "exited" });
    expect(rig.stopCalls).toEqual([4]);
  });

  it("isolates concurrent parents so each stops only after its own child publishes", async () => {
    const rig = controlledRig({ routes: new Map([[1, 2], [3, 4]]) });
    const harness = rig.createHarness();
    const first = rig.startParent(1, harness);
    const second = rig.startParent(3, harness);
    await Promise.all([
      rig.childCompletionCreated.get(2).promise,
      rig.childCompletionCreated.get(4).promise,
    ]);
    rig.childStarts.get(2).resolve();
    rig.childStarts.get(4).resolve();
    await Promise.all([
      rig.childAdvanceEntered.get(2).promise,
      rig.childAdvanceEntered.get(4).promise,
    ]);

    rig.childAdvances.get(2).resolve({ revision: 2 });
    await expect(first.settled).resolves.toMatchObject({ status: "exited" });
    expect(await settlesAfterTurns(second.settled)).toBeUndefined();
    expect(rig.stopCalls).toEqual([2]);

    rig.childAdvances.get(4).resolve({ revision: 2 });
    await expect(second.settled).resolves.toMatchObject({ status: "exited" });
    expect(rig.stopCalls).toEqual([2, 4]);
  });

  it("isolates overlapping harness instances created by one factory", async () => {
    const rig = controlledRig({ routes: new Map([[11, 12], [21, 22]]) });
    const firstHarness = rig.createHarness([11]);
    const secondHarness = rig.createHarness([21]);
    const first = rig.startParent(11, firstHarness);
    const second = rig.startParent(21, secondHarness);
    await Promise.all([
      rig.childCompletionCreated.get(12).promise,
      rig.childCompletionCreated.get(22).promise,
    ]);
    rig.childStarts.get(12).resolve();
    rig.childStarts.get(22).resolve();
    await Promise.all([
      rig.childAdvanceEntered.get(12).promise,
      rig.childAdvanceEntered.get(22).promise,
    ]);
    rig.childAdvances.get(12).resolve({ revision: 2 });
    await expect(first.settled).resolves.toMatchObject({ status: "exited" });
    expect(await settlesAfterTurns(second.settled)).toBeUndefined();
    expect(rig.stopCalls).toEqual([12]);
    rig.childAdvances.get(22).resolve({ revision: 2 });
    await expect(second.settled).resolves.toMatchObject({ status: "exited" });
    expect(rig.stopCalls).toEqual([12, 22]);
  });

  it("keeps a concurrent parent pending when its sibling child fails before readiness", async () => {
    const rig = controlledRig({ routes: new Map([[1, 2], [3, 4]]), failingStarts: [2] });
    const harness = rig.createHarness();
    const failed = rig.startParent(1, harness);
    const independent = rig.startParent(3, harness);
    await Promise.all([
      rig.childCompletionCreated.get(2).promise,
      rig.childCompletionCreated.get(4).promise,
    ]);
    rig.childStarts.get(2).resolve();
    await expect(failed.settled).resolves.toMatchObject({ status: "failed" });
    expect(await settlesAfterTurns(independent.settled)).toBeUndefined();
    expect(rig.stopCalls).toEqual([]);

    rig.childStarts.get(4).resolve();
    await rig.childAdvanceEntered.get(4).promise;
    rig.childAdvances.get(4).resolve({ revision: 2 });
    await expect(independent.settled).resolves.toMatchObject({ status: "exited" });
    expect(rig.stopCalls).toEqual([4]);
  });

  it("resolves the child gate captured before a same-ID replacement is registered", async () => {
    const rig = replacementGateRig();
    await rig.childCompletionCreated.get(1).promise;
    rig.childStarts.get(1).resolve();
    await rig.childAdvanceEntered.get(1).promise;
    rig.childAdvances.get(1).resolve({ revision: 2 });

    await expect(rig.firstParent.settled).resolves.toMatchObject({ status: "exited" });
    expect(rig.stopCalls).toEqual([1]);
    expect(rig.secondParent()).toBeDefined();
    expect(await settlesAfterTurns(rig.secondParent().settled)).toBeUndefined();

    rig.childStarts.get(3).resolve();
    await rig.childAdvanceEntered.get(3).promise;
    expect(await settlesAfterTurns(rig.secondParent().settled)).toBeUndefined();
    rig.childAdvances.get(3).resolve({ revision: 2 });
    await expect(rig.secondParent().settled).resolves.toMatchObject({ status: "exited" });
    expect(rig.stopCalls).toEqual([1, 3]);
  });
});

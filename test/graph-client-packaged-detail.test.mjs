import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const graphClientIndexUrl = pathToFileURL(resolve("packages/graph-client/agent-resource/index.js"));
const graphClientDevelopmentUrl = pathToFileURL(resolve("packages/graph-client/dist/index.js"));
const execFileAsync = promisify(execFile);

function echoedNodeResponse(init, node) {
  const request = JSON.parse(String(init.body));
  return new Response(JSON.stringify({
    node: {
      ...node,
      ...(Object.hasOwn(request, "authoredDetail") ? { authoredDetail: request.authoredDetail } : {}),
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("packaged graph-client authored detail boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has no sibling compiler modules and ignores forged public compiler output", async () => {
    for (const sibling of ["detail-host.js", "detail.js"]) {
      await expect(import(new URL(`./${sibling}`, graphClientIndexUrl).href))
        .rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
    }

    const { NodeObject, RelayerGraphClient, html } = await import(graphClientIndexUrl.href);
    const node = new NodeObject("box", "Safe", "Fallback", "concept", "safe-node");
    node.detailAuthoring.setComponent("safe", html`<p>Trusted source</p>`);
    const forged = Object.freeze({
      version: 1,
      components: Object.freeze([{ id: "forged", order: 0, html: "<p>Forged</p>", css: "" }]),
      mounts: Object.freeze([]),
      assets: Object.freeze([]),
      integritySha256: "f".repeat(64),
    });
    node.detailAuthoring.checkpoint = () => forged;
    node.detailAuthoring.finalize = () => forged;

    let submitted;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      submitted = JSON.parse(String(init.body));
      return echoedNodeResponse(init, {
        id: 1, kind: "concept", icon: "box", title: "Safe", detail: "Fallback", state: "draft",
      });
    }));

    await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitNode(node);

    expect(submitted.authoredDetail.components).toEqual([
      { id: "safe", order: 0, html: "<p>Trusted source</p>", css: "" },
    ]);
  });

  it("does not advertise unresolved asset authoring through the agent resource", async () => {
    const graphClient = await import(graphClientIndexUrl.href);
    expect(graphClient.assetRef).toBeUndefined();
  });

  it("registers submit and detail single-flight promises before synchronous transport re-entry", async () => {
    const { NodeObject, RelayerGraphClient, html } = await import(graphClientIndexUrl.href);
    const node = new NodeObject("box", "Reentrant", "Fallback", "concept", "reentrant-node");
    node.detailAuthoring.setComponent("content", html`<p>Reentrant</p>`);
    let nodePosts = 0;
    let didReenter = false;
    let reentrantSubmission;
    let reentrantCheckpoint;
    let concurrentCheckpoint;
    let submittedDetail;
    let client;
    vi.stubGlobal("fetch", vi.fn((url, init) => {
      if (!didReenter) {
        didReenter = true;
        reentrantSubmission = client.submitNode(node);
        reentrantCheckpoint = client.checkpointNodeDetail(node);
        concurrentCheckpoint = client.checkpointNodeDetail(node);
      }
      nodePosts += 1;
      submittedDetail = JSON.parse(String(init.body)).authoredDetail;
      return Promise.resolve(echoedNodeResponse(init, {
          id: 40,
          kind: "concept",
          icon: "box",
          title: "Reentrant",
          detail: "Fallback",
          state: "draft",
      }));
    }));

    client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const firstSubmission = client.submitNode(node);

    await vi.waitFor(() => expect(reentrantSubmission).toBeDefined());
    expect(reentrantSubmission).toBe(firstSubmission);
    expect(concurrentCheckpoint).toBe(reentrantCheckpoint);
    const [accepted, reentrantAccepted] = await Promise.all([firstSubmission, reentrantSubmission]);
    const [checkpoint, concurrentCompiled] = await Promise.all([reentrantCheckpoint, concurrentCheckpoint]);
    expect(reentrantAccepted).toBe(accepted);
    expect(concurrentCompiled).toBe(checkpoint);
    expect(submittedDetail).toEqual(checkpoint);
    expect(await client.submitNode(node)).toBe(accepted);
    expect(nodePosts).toBe(1);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(node.ref).toBe(accepted);
  });

  it("clears failed reentrant placeholders and single-flights an explicit retry", async () => {
    const { GraphApiError, NodeObject, RelayerGraphClient, html } = await import(graphClientIndexUrl.href);
    const node = new NodeObject("box", "Retry re-entry", "Fallback", "concept", "retry-reentrant-node");
    node.detailAuthoring.setComponent("content", html`<p>Retry</p>`);
    let nodePosts = 0;
    let didReenter = false;
    let reentrantSubmission;
    let client;
    vi.stubGlobal("fetch", vi.fn((url, init) => {
      if (!didReenter) {
        didReenter = true;
        reentrantSubmission = client.submitNode(node);
        return Promise.resolve(new Response(JSON.stringify({
          code: "temporary_failure",
          path: "node",
          message: "retry",
        }), { status: 503, headers: { "content-type": "application/json" } }));
      }
      nodePosts += 1;
      return Promise.resolve(echoedNodeResponse(init, {
          id: 43,
          kind: "concept",
          icon: "box",
          title: "Retry re-entry",
          detail: "Fallback",
          state: "draft",
      }));
    }));

    client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const failedSubmission = client.submitNode(node);
    const failedExpectation = expect(failedSubmission).rejects.toBeInstanceOf(GraphApiError);
    await vi.waitFor(() => expect(reentrantSubmission).toBeDefined());
    expect(reentrantSubmission).toBe(failedSubmission);
    await failedExpectation;

    const retrySubmission = client.submitNode(node);
    const concurrentRetry = client.submitNode(node);
    expect(concurrentRetry).toBe(retrySubmission);
    const accepted = await retrySubmission;
    expect(await concurrentRetry).toBe(accepted);
    expect(await client.submitNode(node)).toBe(accepted);
    expect(nodePosts).toBe(1);
    expect(node.ref).toBe(accepted);
  });

  it("applies one immutable accepted response through code-owned state across concurrency and retries", async () => {
    const { NodeObject, RelayerGraphClient } = await import(graphClientIndexUrl.href);
    const node = new NodeObject("box", "Stable ref", "Fallback", "concept", "stable-ref-node");
    let nodeRequests = 0;
    let releaseResponse;
    const heldResponse = new Promise((resolveResponse) => { releaseResponse = resolveResponse; });
    let setterInvocations = 0;
    const serverNode = {
      id: 41, kind: "concept", icon: "box", title: "Stable ref", detail: "Fallback", state: "draft",
    };
    vi.stubGlobal("fetch", vi.fn(async () => {
      nodeRequests += 1;
      await heldResponse;
      return { ok: true, status: 200, json: async () => ({ node: serverNode }) };
    }));

    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const first = client.submitNode(node);
    const concurrent = client.submitNode(node);
    await vi.waitFor(() => expect(nodeRequests).toBeGreaterThan(0));
    expect(() => Object.defineProperty(node, "ref", { writable: false })).toThrow(TypeError);
    expect(() => Object.defineProperty(node, "ref", {
      enumerable: true,
      configurable: true,
      get: () => undefined,
      set: () => { setterInvocations += 1; throw new TypeError("caller setter invoked"); },
    })).toThrow(TypeError);
    expect(() => { node.ref = { id: 999 }; }).toThrow(TypeError);
    releaseResponse();

    const [accepted, concurrentAccepted] = await Promise.all([first, concurrent]);
    expect(concurrentAccepted).toBe(accepted);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(() => { accepted.id = 999; }).toThrow(TypeError);
    serverNode.id = 999;
    serverNode.title = "Mutated server object";
    expect(accepted).toMatchObject({ id: 41, title: "Stable ref" });
    expect(await client.submitNode(node)).toBe(accepted);
    expect(nodeRequests).toBe(1);
    expect(setterInvocations).toBe(0);
    expect(node.ref).toBe(accepted);
    expect(node.ref).toMatchObject({ id: 41 });
    expect(Object.getOwnPropertyDescriptor(node, "ref")).toMatchObject({
      configurable: false,
      enumerable: true,
      get: expect.any(Function),
      set: undefined,
    });
  });

  it("rejects malformed successful node responses deterministically and permits an explicit retry", async () => {
    const { GraphApiError, NodeObject, RelayerGraphClient } = await import(graphClientIndexUrl.href);
    const validNode = {
      id: 42,
      leasedActionId: null,
      kind: "concept",
      icon: "box",
      title: "Validated",
      detail: "Fallback",
      state: "draft",
    };
    const cases = [
      ["null", null],
      ["empty", {}],
      ["unknown-response-field", { node: validNode, extra: true }],
      ["null-node", { node: null }],
      ["unknown-node-field", { node: { ...validNode, extra: true } }],
      ["invalid-id", { node: { ...validNode, id: 0 } }],
      ["invalid-lease", { node: { ...validNode, leasedActionId: "42" } }],
      ["invalid-state", { node: { ...validNode, state: "published" } }],
      ["blank-title", { node: { ...validNode, title: "  " } }],
    ];

    for (const [name, responseBody] of cases) {
      const node = new NodeObject("box", "Validated", "Fallback", "concept", `invalid-response-${name}`);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      })));
      const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
      const submission = client.submitNode(node);
      await expect(submission).rejects.toBeInstanceOf(GraphApiError);
      await expect(submission).rejects.toMatchObject({ status: 200, code: "invalid_node_response" });
      expect(node.ref).toBeUndefined();
    }

    const retryNode = new NodeObject("box", "Validated", "Fallback", "concept", "invalid-response-retry");
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests += 1;
      return new Response(JSON.stringify(requests === 1 ? {} : { node: validNode }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const retryClient = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    await expect(retryClient.submitNode(retryNode)).rejects.toMatchObject({ code: "invalid_node_response" });
    await expect(retryClient.submitNode(retryNode)).resolves.toMatchObject({ id: 42 });
    expect(requests).toBe(2);
  });

  it("snapshots successful node envelopes from ordinary data descriptors without invoking hostile fields", async () => {
    const { GraphApiError, NodeObject, RelayerGraphClient } = await import(graphClientIndexUrl.href);
    const validNode = {
      id: 43,
      leasedActionId: null,
      kind: "concept",
      icon: "box",
      title: "Descriptor snapshot",
      detail: "Fallback",
      state: "draft",
    };
    let getterReads = 0;
    const changingId = { ...validNode };
    Object.defineProperty(changingId, "id", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return getterReads < 3 ? 43 : 999;
      },
    });
    const throwingState = { ...validNode };
    Object.defineProperty(throwingState, "state", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        throw new TypeError("caller state getter escaped");
      },
    });
    const envelopeAccessor = {};
    Object.defineProperty(envelopeAccessor, "node", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return validNode;
      },
    });
    const inheritedEnvelope = Object.create({ node: validNode });
    const symbolEnvelope = { node: validNode, [Symbol("unknown")]: true };
    const hiddenEnvelopeNode = {};
    Object.defineProperty(hiddenEnvelopeNode, "node", { enumerable: false, value: validNode });
    const inheritedState = Object.assign(Object.create({ state: "draft" }), {
      id: 43, leasedActionId: null, kind: "concept", icon: "box", title: "Inherited", detail: "Fallback",
    });
    const symbolField = { ...validNode, [Symbol("unknown")]: true };
    const hiddenTitle = { ...validNode };
    Object.defineProperty(hiddenTitle, "title", { enumerable: false, value: "Hidden" });
    const descriptorTrap = new Proxy({ ...validNode }, {
      getOwnPropertyDescriptor: () => { throw new TypeError("caller descriptor trap escaped"); },
    });
    const ownKeysTrap = new Proxy({ node: validNode }, {
      ownKeys: () => { throw new TypeError("caller ownKeys trap escaped"); },
    });
    const cases = [
      ["changing-id", { node: changingId }],
      ["throwing-state", { node: throwingState }],
      ["envelope-accessor", envelopeAccessor],
      ["inherited-envelope", inheritedEnvelope],
      ["symbol-envelope", symbolEnvelope],
      ["hidden-envelope-node", hiddenEnvelopeNode],
      ["inherited-state", { node: inheritedState }],
      ["symbol-field", { node: symbolField }],
      ["hidden-title", { node: hiddenTitle }],
      ["descriptor-trap", { node: descriptorTrap }],
      ["own-keys-trap", ownKeysTrap],
    ];

    for (const [name, hostileBody] of cases) {
      const node = new NodeObject("box", "Descriptor snapshot", "Fallback", "concept", `descriptor-${name}`);
      let requests = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        requests += 1;
        return { ok: true, status: 200, json: async () => requests === 1 ? hostileBody : { node: validNode } };
      }));
      const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
      const first = client.submitNode(node);
      await expect(first).rejects.toBeInstanceOf(GraphApiError);
      await expect(first).rejects.toMatchObject({ status: 200, code: "invalid_node_response" });
      expect(node.ref).toBeUndefined();
      await expect(client.submitNode(node)).resolves.toMatchObject({ id: 43 });
      expect(requests).toBe(2);
    }
    expect(getterReads).toBe(0);
  });

  it("reuses one coherent node request envelope across microtasks, concurrency, and retries", async () => {
    const {
      LayerLayoutObject,
      LayerObject,
      NodeObject,
      RelayerGraphClient,
      detailCapability,
      html,
    } = await import(graphClientIndexUrl.href);
    const node = new NodeObject("box", "Original title", "Original detail", "concept", "original-owner");
    const sourceLayer = new LayerObject([node], [], new LayerLayoutObject([]), "source-layer");
    const action = {
      kind: "invoke",
      label: "Run",
      interactionText: "Run",
      sourceLayer,
      clientKey: "run-action",
    };
    node.detailAuthoring.setComponent(
      "action",
      html`<button gc=${detailCapability.invoke("run", action)}>Run</button>`,
    );

    const requestBodies = [];
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requestBodies.push(String(init.body));
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ error: { code: "temporary_failure" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return echoedNodeResponse(init, {
        id: 1, kind: "concept", icon: "box", title: "Original title", detail: "Original detail", state: "draft",
      });
    }));

    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const first = client.submitNode(node);
    const concurrent = client.submitNode(node);
    queueMicrotask(() => {
      node.clientKey = "changed-owner";
      node.kind = "changed-kind";
      node.icon = "changed-icon";
      node.title = "Changed title";
      node.detail = "Changed detail";
    });

    const concurrentResults = await Promise.allSettled([first, concurrent]);
    expect(concurrentResults.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await client.submitNode(node);

    expect(requestBodies).toHaveLength(2);
    expect(new Set(requestBodies).size).toBe(1);
    const submitted = JSON.parse(requestBodies[0]);
    expect(submitted).toMatchObject({
      clientKey: "original-owner",
      kind: "concept",
      icon: "box",
      title: "Original title",
      detail: "Original detail",
    });
    expect(submitted.authoredDetail.mounts[0].capability.action.sourceNode).toEqual({ clientKey: "original-owner" });
  });

  it("rejects accessor and proxy-trapped node request envelopes source-locally", async () => {
    const { DetailCompilationError, NodeObject, RelayerGraphClient } = await import(graphClientIndexUrl.href);
    let clientKeyReads = 0;
    const accessorNode = new NodeObject("box", "Accessor", "Fallback", "concept", "accessor-node");
    Object.defineProperty(accessorNode, "clientKey", {
      enumerable: true,
      configurable: true,
      get() {
        clientKeyReads += 1;
        return "substituted-node";
      },
    });
    const trappedNode = new Proxy(new NodeObject("box", "Trapped", "Fallback", "concept", "trapped-node"), {
      ownKeys: () => { throw new TypeError("caller node proxy trap escaped"); },
    });
    const forgedRefOwner = new NodeObject("box", "Forged ref", "Fallback", "concept", "forged-ref-node");
    const forgedRefNode = Object.create(NodeObject.prototype, {
      ...Object.getOwnPropertyDescriptors(forgedRefOwner),
      ref: { configurable: true, enumerable: true, writable: true, value: undefined },
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });

    for (const node of [accessorNode, trappedNode, forgedRefNode]) {
      await expect(client.submitNode(node)).rejects.toBeInstanceOf(DetailCompilationError);
      await expect(client.submitNode(node)).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: "node_envelope_invalid", path: "node" })],
      });
    }
    expect(clientKeyReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a detail builder owned by a different NodeObject as a node envelope error", async () => {
    const { DetailCompilationError, NodeObject, RelayerGraphClient } = await import(graphClientIndexUrl.href);
    const owner = new NodeObject("box", "Owner", "Fallback", "concept", "builder-owner");
    const unrelated = new NodeObject("box", "Unrelated", "Fallback", "concept", "builder-unrelated");
    Object.defineProperty(owner, "detailAuthoring", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: unrelated.detailAuthoring,
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const submitting = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitNode(owner);
    await expect(submitting).rejects.toBeInstanceOf(DetailCompilationError);
    await expect(submitting).rejects.toMatchObject({
      name: "DetailCompilationError",
      issues: [expect.objectContaining({ code: "node_envelope_invalid", path: "node" })],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("snapshots asset references without invoking caller accessors or proxy traps", async () => {
    const {
      DetailCompilationError,
      NodeObject,
      RelayerGraphClient,
      assetRef,
      html,
    } = await import(graphClientDevelopmentUrl.href);
    const brandedAsset = assetRef("brand-source");
    const assetBrand = Reflect.ownKeys(brandedAsset).find((key) => typeof key === "symbol");
    let throwingReads = 0;
    let changingReads = 0;
    const cases = [
      ["throwing", {
        [assetBrand]: true,
        get logicalId() {
          throwingReads += 1;
          throw new TypeError("caller getter escaped");
        },
      }],
      ["changing", {
        [assetBrand]: true,
        get logicalId() {
          changingReads += 1;
          return changingReads === 1 ? "safe-logo" : "substituted-logo";
        },
      }],
      ["trapped", new Proxy({ [assetBrand]: true, logicalId: "safe-logo" }, {
        ownKeys: () => { throw new TypeError("caller asset proxy trap escaped"); },
      })],
    ];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const [name, reference] of cases) {
      const node = new NodeObject("box", "Asset", "Fallback", "concept", `asset-${name}`);
      node.detailAuthoring.setComponent(name, html`<img alt="Logo" asset=${reference}>`);
      const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
      await expect(client.checkpointNodeDetail(node)).rejects.toBeInstanceOf(DetailCompilationError);
      await expect(client.checkpointNodeDetail(node)).rejects.toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ code: "asset_reference_invalid", componentId: name })]),
      });
    }
    expect(throwingReads).toBe(0);
    expect(changingReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses one frozen logical asset identity for resolution, mounts, and the asset table", async () => {
    const { NodeObject, RelayerGraphClient, assetRef, html } = await import(graphClientDevelopmentUrl.href);
    const brandedAsset = assetRef("brand-source");
    const assetBrand = Reflect.ownKeys(brandedAsset).find((key) => typeof key === "symbol");
    const reference = { [assetBrand]: true, logicalId: "safe-logo" };
    const node = new NodeObject("box", "Asset", "Fallback", "concept", "asset-owner");
    node.detailAuthoring.setComponent("logo", html`<img alt="Logo" asset=${reference}>`);
    const requestedIds = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(String(url)).toContain("/detail-assets/resolve");
      requestedIds.push(...JSON.parse(String(init.body)).logicalIds);
      queueMicrotask(() => { reference.logicalId = "substituted-logo"; });
      await Promise.resolve();
      return new Response(JSON.stringify({
        assets: [{
          logicalId: "safe-logo",
          authority: "current",
          availability: "available",
          digestSha256: "a".repeat(64),
          mediaType: "image/png",
          representation: { kind: "image", sanitized: true },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const compiled = await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 })
      .checkpointNodeDetail(node);

    expect(requestedIds).toEqual(["safe-logo"]);
    expect(compiled.mounts).toEqual([
      expect.objectContaining({ kind: "asset", assetId: "safe-logo" }),
    ]);
    expect(compiled.assets).toEqual([
      expect.objectContaining({ id: "safe-logo", digestSha256: "a".repeat(64) }),
    ]);
  });

  it("submits one pre-await authored program snapshot and freezes the accepted builder", async () => {
    const {
      LayerLayoutObject,
      LayerObject,
      NodeObject,
      RelayerGraphClient,
      assetRef,
      detailCapability,
      html,
    } = await import(graphClientDevelopmentUrl.href);
    const owner = new NodeObject("box", "Snapshot", "Fallback", "concept", "snapshot-owner");
    const sourceLayer = new LayerObject([owner], [], new LayerLayoutObject([]), "original-layer");
    const action = {
      kind: "invoke",
      label: "Original action",
      interactionText: "Run original action",
      sourceLayer,
      clientKey: "original-action",
    };
    owner.detailAuthoring.setComponent("original", html`
      <button gc=${detailCapability.invoke("run", action)}>Original markup</button>
      <img alt="Original logo" asset=${assetRef("original-logo")}>
    `);

    let resolverStarted;
    const started = new Promise((resolveStarted) => { resolverStarted = resolveStarted; });
    let releaseResolver;
    const heldResolver = new Promise((resolveResolver) => { releaseResolver = resolveResolver; });
    let submitted;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).includes("/detail-assets/resolve")) {
        resolverStarted();
        await heldResolver;
        return new Response(JSON.stringify({ assets: [{
          logicalId: "original-logo",
          authority: "current",
          availability: "available",
          digestSha256: "a".repeat(64),
          mediaType: "image/png",
          representation: { kind: "image", sanitized: true },
        }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      submitted = JSON.parse(String(init.body));
      return echoedNodeResponse(init, {
        id: 1, kind: "concept", icon: "box", title: "Snapshot", detail: "Fallback", state: "draft",
      });
    }));

    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const pending = client.submitNode(owner);
    await started;
    expect(() => owner.detailAuthoring.setComponent("late", html`<p>Late mutation</p>`))
      .toThrow("finalized");
    action.clientKey = "substituted-action";
    action.label = "Substituted action";
    sourceLayer.clientKey = "substituted-layer";
    sourceLayer.nodes = [];
    releaseResolver();
    await pending;

    expect(submitted.authoredDetail.components.map((component) => component.id)).toEqual(["original"]);
    expect(submitted.authoredDetail.components[0].html).toContain("Original markup");
    expect(submitted.authoredDetail.mounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "capability",
        capability: {
          kind: "invoke",
          action: {
            clientKey: "original-action",
            sourceNode: { clientKey: "snapshot-owner" },
            sourceLayer: { clientKey: "original-layer" },
          },
        },
      }),
      expect.objectContaining({ kind: "asset", assetId: "original-logo" }),
    ]));
    expect(() => owner.detailAuthoring.setComponent("after-submit", html`<p>Rejected</p>`))
      .toThrow(/finalized/);
  });

  it("checkpoints the pre-await program while leaving the live builder repairable", async () => {
    const {
      LayerLayoutObject,
      LayerObject,
      NodeObject,
      RelayerGraphClient,
      assetRef,
      detailCapability,
      html,
    } = await import(graphClientDevelopmentUrl.href);
    const owner = new NodeObject("box", "Checkpoint", "Fallback", "concept", "checkpoint-owner");
    const sourceLayer = new LayerObject([owner], [], new LayerLayoutObject([]), "checkpoint-layer");
    const action = {
      kind: "invoke",
      label: "Original",
      interactionText: "Original",
      sourceLayer,
      clientKey: "checkpoint-action",
    };
    owner.detailAuthoring.setComponent("card", html`
      <button gc=${detailCapability.invoke("run", action)}>Original checkpoint</button>
      <img alt="Logo" asset=${assetRef("checkpoint-logo")}>
    `);
    let resolverStarted;
    const started = new Promise((resolveStarted) => { resolverStarted = resolveStarted; });
    let releaseResolver;
    const heldResolver = new Promise((resolveResolver) => { releaseResolver = resolveResolver; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      resolverStarted();
      await heldResolver;
      return new Response(JSON.stringify({ assets: [{
        logicalId: "checkpoint-logo",
        authority: "current",
        availability: "available",
        digestSha256: "b".repeat(64),
        mediaType: "image/png",
        representation: { kind: "image", sanitized: true },
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const pending = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 })
      .checkpointNodeDetail(owner);
    await started;
    owner.detailAuthoring.setComponent("card", html`<p>Replacement markup</p>`);
    action.clientKey = "replacement-action";
    sourceLayer.clientKey = "replacement-layer";
    sourceLayer.nodes = [];
    releaseResolver();
    const compiled = await pending;

    expect(compiled.components).toEqual([
      expect.objectContaining({ id: "card", html: expect.stringContaining("Original checkpoint") }),
    ]);
    expect(compiled.mounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "capability",
        capability: expect.objectContaining({
          action: expect.objectContaining({ clientKey: "checkpoint-action", sourceLayer: { clientKey: "checkpoint-layer" } }),
        }),
      }),
    ]));
    expect(() => owner.detailAuthoring.setComponent("repair", html`<p>Still repairable</p>`)).not.toThrow();
  });

  it("rejects forged HTML and CSS template descriptors without invoking caller code", async () => {
    const { DetailCompilationError, NodeObject, RelayerGraphClient, css, html } = await import(graphClientIndexUrl.href);
    const templateBrand = Reflect.ownKeys(html`<p>Brand</p>`).find((key) => typeof key === "symbol");
    let accessorReads = 0;
    const inherited = Object.create({ [templateBrand]: "html" });
    inherited.strings = ["<p>Inherited</p>"];
    inherited.values = [];
    const symbolTemplate = { [templateBrand]: "html", strings: ["<p>Symbol</p>"], values: [] };
    symbolTemplate[Symbol("unknown")] = true;
    const trappedStrings = new Proxy(["<p>Trapped</p>"], {
      ownKeys: () => { throw new TypeError("caller template array trap escaped"); },
    });
    const cases = [
      ["missing", { [templateBrand]: "html", strings: ["<p>Missing</p>"] }, css``],
      ["accessor", {
        [templateBrand]: "html",
        get strings() {
          accessorReads += 1;
          return ["<p>Accessor</p>"];
        },
        values: [],
      }, css``],
      ["inherited", inherited, css``],
      ["symbol", symbolTemplate, css``],
      ["proxy", new Proxy({ [templateBrand]: "html", strings: ["<p>Proxy</p>"], values: [] }, {
        ownKeys: () => { throw new TypeError("caller template proxy trap escaped"); },
      }), css``],
      ["array-proxy", { [templateBrand]: "html", strings: trappedStrings, values: [] }, css``],
      ["css-accessor", html`<p>CSS</p>`, {
        [templateBrand]: "css",
        strings: [".card{display:grid}"],
        get values() {
          accessorReads += 1;
          return [];
        },
      }],
    ];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    for (const [name, markup, styles] of cases) {
      const node = new NodeObject("box", "Template", "Fallback", "concept", `template-${name}`);
      node.detailAuthoring.setComponent(name, markup, styles);
      await expect(client.checkpointNodeDetail(node)).rejects.toBeInstanceOf(DetailCompilationError);
      await expect(client.checkpointNodeDetail(node)).rejects.toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ code: "template_invalid", componentId: name })]),
      });
    }
    expect(accessorReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects accessor, proxy, and prototype-substituted navigate targets without reading them", async () => {
    const {
      DetailCompilationError,
      LayerLayoutObject,
      LayerObject,
      NodeObject,
      RelayerGraphClient,
      detailCapability,
      html,
    } = await import(graphClientIndexUrl.href);
    let targetReads = 0;
    const accessorTarget = new LayerObject([], [], new LayerLayoutObject([]), "accessor-target");
    Object.defineProperty(accessorTarget, "clientKey", {
      enumerable: true,
      configurable: true,
      get() {
        targetReads += 1;
        return "substituted-target";
      },
    });
    const trappedTarget = new Proxy(new LayerObject([], [], new LayerLayoutObject([]), "trapped-target"), {
      ownKeys: () => { throw new TypeError("caller target proxy trap escaped"); },
    });
    const inheritedTarget = Object.create(new LayerObject([], [], new LayerLayoutObject([]), "inherited-target"));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });

    for (const [name, target] of [
      ["accessor-target", accessorTarget],
      ["trapped-target", trappedTarget],
      ["inherited-target", inheritedTarget],
    ]) {
      const owner = new NodeObject("box", "Navigate", "Fallback", "concept", `${name}-owner`);
      const sourceLayer = new LayerObject([owner], [], new LayerLayoutObject([]), `${name}-source`);
      const action = {
        kind: "navigate", relation: "expand", label: "Open", target, sourceLayer, clientKey: `${name}-action`,
      };
      owner.detailAuthoring.setComponent(name, html`<button gc=${detailCapability.expand("open", action)}>Open</button>`);
      await expect(client.checkpointNodeDetail(owner)).rejects.toBeInstanceOf(DetailCompilationError);
      await expect(client.checkpointNodeDetail(owner)).rejects.toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ code: "capability_invalid", componentId: name })]),
      });
    }
    expect(targetReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects forged action shapes through the packaged public checkpoint seam", async () => {
    const {
      DetailCompilationError,
      LayerLayoutObject,
      LayerObject,
      NodeObject,
      RelayerGraphClient,
      detailCapability,
      html,
    } = await import(graphClientIndexUrl.href);
    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const accessorReads = new Map();
    const cases = [
      {
        name: "node-target",
        capability: "expand",
        action: (owner, sourceLayer) => ({
          kind: "navigate", relation: "expand", label: "Open", target: owner, sourceLayer, clientKey: "node-target",
        }),
      },
      {
        name: "extra-option-field",
        capability: "input",
        action: (_owner, sourceLayer) => ({
          kind: "input", label: "Choose", control: "single_select", prompt: "Choose",
          options: [{ key: "one", label: "One", value: "forged" }], sourceLayer, clientKey: "extra-option-field",
        }),
      },
      {
        name: "unknown-action-field",
        capability: "invoke",
        action: (_owner, sourceLayer) => ({
          kind: "invoke", label: "Run", interactionText: "Run", sourceLayer, clientKey: "unknown-action-field", targetLayerId: 42,
        }),
      },
      {
        name: "invalid-presentation",
        capability: "invoke",
        action: (_owner, sourceLayer) => ({
          kind: "invoke", label: "Run", interactionText: "Run", sourceLayer, clientKey: "invalid-presentation",
          variant: "banner", description: "Forged presentation",
        }),
      },
      {
        name: "invalid-description",
        capability: "invoke",
        action: (_owner, sourceLayer) => ({
          kind: "invoke", label: "Run", interactionText: "Run", sourceLayer, clientKey: "invalid-description",
          variant: "pill", description: "Cards only",
        }),
      },
      {
        name: "throwing-field",
        capability: "invoke",
        action: (_owner, sourceLayer) => {
          let reads = 0;
          accessorReads.set("throwing-field", () => reads);
          return {
            kind: "invoke",
            get label() { reads += 1; throw new TypeError("caller getter escaped"); },
            interactionText: "Run",
            sourceLayer,
            clientKey: "throwing-field",
          };
        },
      },
      {
        name: "changing-client-key-getter",
        capability: "invoke",
        action: (_owner, sourceLayer) => {
          let reads = 0;
          accessorReads.set("changing-client-key-getter", () => reads);
          return {
            kind: "invoke",
            label: "Run",
            interactionText: "Run",
            sourceLayer,
            get clientKey() { return reads++ === 0 ? "first-client-key" : "substituted-client-key"; },
          };
        },
      },
      {
        name: "changing-source-layer-getter",
        capability: "invoke",
        action: (owner, sourceLayer) => {
          const unrelatedNode = new NodeObject("box", "Unrelated", "Fallback", "concept", "unrelated-node");
          const unrelatedLayer = new LayerObject(
            [unrelatedNode], [], new LayerLayoutObject([]), "unrelated-layer",
          );
          let reads = 0;
          accessorReads.set("changing-source-layer-getter", () => reads);
          return {
            kind: "invoke",
            label: "Run",
            interactionText: "Run",
            get sourceLayer() { return reads++ < 2 ? sourceLayer : unrelatedLayer; },
            clientKey: `${owner.clientKey}-action`,
          };
        },
      },
      {
        name: "changing-layer-client-key-getter",
        capability: "invoke",
        action: (_owner, sourceLayer) => {
          const originalClientKey = sourceLayer.clientKey;
          let reads = 0;
          accessorReads.set("changing-layer-client-key-getter", () => reads);
          Object.defineProperty(sourceLayer, "clientKey", {
            configurable: true,
            enumerable: true,
            get() { return reads++ === 0 ? originalClientKey : "substituted-layer-client-key"; },
          });
          return {
            kind: "invoke",
            label: "Run",
            interactionText: "Run",
            sourceLayer,
            clientKey: "changing-layer-client-key-getter-action",
          };
        },
      },
      {
        name: "changing-layer-nodes-getter",
        capability: "invoke",
        action: (owner, sourceLayer) => {
          let reads = 0;
          accessorReads.set("changing-layer-nodes-getter", () => reads);
          Object.defineProperty(sourceLayer, "nodes", {
            configurable: true,
            enumerable: true,
            get() { return reads++ === 0 ? [owner] : []; },
          });
          return {
            kind: "invoke",
            label: "Run",
            interactionText: "Run",
            sourceLayer,
            clientKey: "changing-layer-nodes-getter-action",
          };
        },
      },
      {
        name: "trapping-layer-nodes-getter",
        capability: "invoke",
        action: (_owner, sourceLayer) => {
          let reads = 0;
          accessorReads.set("trapping-layer-nodes-getter", () => reads);
          Object.defineProperty(sourceLayer, "nodes", {
            configurable: true,
            enumerable: true,
            get() { reads += 1; throw new TypeError("caller nodes trap escaped"); },
          });
          return {
            kind: "invoke",
            label: "Run",
            interactionText: "Run",
            sourceLayer,
            clientKey: "trapping-layer-nodes-getter-action",
          };
        },
      },
      {
        name: "distinct-same-key-layer-member",
        capability: "invoke",
        code: "capability_source_layer_mismatch",
        action: (owner, sourceLayer) => {
          sourceLayer.nodes = [
            new NodeObject("box", "Impostor", "Fallback", "concept", owner.clientKey),
          ];
          return {
            kind: "invoke",
            label: "Run",
            interactionText: "Run",
            sourceLayer,
            clientKey: "distinct-same-key-layer-member-action",
          };
        },
      },
      {
        name: "second-read-throw",
        capability: "invoke",
        action: (_owner, sourceLayer) => {
          let reads = 0;
          accessorReads.set("second-read-throw", () => reads);
          return {
            kind: "invoke",
            label: "Run",
            interactionText: "Run",
            sourceLayer,
            get clientKey() {
              if (reads++ === 0) return "single-readable-client-key";
              throw new TypeError("action field was read twice");
            },
          };
        },
      },
      {
        name: "prototype-only-action",
        capability: "invoke",
        action: (_owner, sourceLayer) => Object.create({
          kind: "invoke",
          label: "Run",
          interactionText: "Run",
          sourceLayer,
          clientKey: "prototype-only-action",
          inheritedUnknown: "forged",
        }),
      },
      {
        name: "nested-option-accessor",
        capability: "input",
        action: (_owner, sourceLayer) => {
          let reads = 0;
          accessorReads.set("nested-option-accessor", () => reads);
          return {
            kind: "input",
            label: "Choose",
            control: "single_select",
            prompt: "Choose",
            options: [{ get key() { reads += 1; return "one"; }, label: "One" }],
            sourceLayer,
            clientKey: "nested-option-accessor",
          };
        },
      },
      {
        name: "presentation-accessor",
        capability: "invoke",
        action: (_owner, sourceLayer) => {
          let reads = 0;
          accessorReads.set("presentation-accessor", () => reads);
          return {
            kind: "invoke",
            label: "Run",
            interactionText: "Run",
            sourceLayer,
            clientKey: "presentation-accessor",
            get variant() { reads += 1; return "pill"; },
          };
        },
      },
      {
        name: "symbol-field",
        capability: "invoke",
        action: (_owner, sourceLayer) => {
          const action = {
            kind: "invoke", label: "Run", interactionText: "Run", sourceLayer, clientKey: "symbol-field",
          };
          action[Symbol("forged")] = true;
          return action;
        },
      },
      {
        name: "non-enumerable-field",
        capability: "invoke",
        action: (_owner, sourceLayer) => {
          const action = { kind: "invoke", interactionText: "Run", sourceLayer, clientKey: "non-enumerable-field" };
          Object.defineProperty(action, "label", { value: "Run" });
          return action;
        },
      },
      {
        name: "descriptor-proxy-trap",
        capability: "invoke",
        action: () => new Proxy({}, {
          getPrototypeOf: () => Object.prototype,
          ownKeys: () => { throw new TypeError("caller descriptor trap escaped"); },
        }),
      },
    ];

    for (const scenario of cases) {
      const owner = new NodeObject("box", "Owner", "Fallback", "concept", `${scenario.name}-owner`);
      const sourceLayer = new LayerObject([owner], [], new LayerLayoutObject([]), `${scenario.name}-layer`);
      const action = scenario.action(owner, sourceLayer);
      const capability = detailCapability[scenario.capability](scenario.name, action);
      owner.detailAuthoring.setComponent(scenario.name, html`<button gc=${capability}>Action</button>`);

      await expect(client.checkpointNodeDetail(owner)).rejects.toBeInstanceOf(DetailCompilationError);
      await expect(client.checkpointNodeDetail(owner)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: scenario.code ?? "capability_invalid", componentId: scenario.name, line: 1 }),
        ]),
      });
      const readCount = accessorReads.get(scenario.name);
      if (readCount !== undefined) expect(readCount()).toBe(0);
    }
  });

  it("rejects external-link accessor substitution and capability proxy traps", async () => {
    const {
      DetailCompilationError,
      NodeObject,
      RelayerGraphClient,
      detailCapability,
      html,
    } = await import(graphClientIndexUrl.href);
    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const brandedLink = detailCapability.externalLink("brand-source", "https://safe.example/");
    const capabilityBrand = Reflect.ownKeys(brandedLink).find((key) => typeof key === "symbol");

    let hrefReads = 0;
    const changingHref = {
      [capabilityBrand]: true,
      key: "changing-href",
      kind: "link",
      get href() {
        hrefReads += 1;
        return hrefReads <= 2 ? "https://safe.example/" : "javascript:alert(1)";
      },
    };
    const trappedCapability = new Proxy({
      [capabilityBrand]: true,
      key: "trapped-capability",
      kind: "link",
      href: "https://safe.example/",
    }, {
      has: () => { throw new TypeError("caller has trap escaped"); },
    });

    for (const [name, capability] of [
      ["changing-href", changingHref],
      ["trapped-capability", trappedCapability],
    ]) {
      const node = new NodeObject("box", "Owner", "Fallback", "concept", `${name}-owner`);
      node.detailAuthoring.setComponent(name, html`<a gc=${capability}>Open</a>`);
      await expect(client.checkpointNodeDetail(node)).rejects.toBeInstanceOf(DetailCompilationError);
    }
    expect(hrefReads).toBe(0);
  });

  it("imports, compiles, and submits from the exact isolated packaged resource layout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-packaged-graph-client-"));
    try {
      const resourcesPath = join(directory, "resources");
      const packagedRoot = join(resourcesPath, "graph-client");
      await cp(resolve("packages/graph-client/agent-resource"), packagedRoot, { recursive: true });
      expect(await readdir(packagedRoot)).toEqual(["index.js"]);
      const packagedUrl = pathToFileURL(join(resourcesPath, "graph-client", "index.js")).href;

      const probe = `
        for (const sibling of ["detail-host.js", "detail.js"]) {
          try {
            await import(new URL("./" + sibling, ${JSON.stringify(packagedUrl)}).href);
            process.exit(10);
          } catch (error) {
            if (error?.code !== "ERR_MODULE_NOT_FOUND") process.exit(11);
          }
        }
        const { NodeObject, RelayerGraphClient, css, html } = await import(${JSON.stringify(packagedUrl)});
        const node = new NodeObject("box", "Packaged", "Fallback", "concept", "packaged-node");
        node.detailAuthoring.setComponent(
          "layout",
          html\`<table><tbody><tr><td>Packaged</td></tr></tbody></table>\`,
          css\`.layout:first-child{display:grid;grid-template-columns:minmax(10rem,1fr) 2fr}\`,
        );
        let submitted;
        globalThis.fetch = async (_url, init) => {
          submitted = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ node: { id: 1, kind: "concept", icon: "box", title: "Packaged", detail: "Fallback", authoredDetail: submitted.authoredDetail, state: "draft" } }), { status: 200, headers: { "content-type": "application/json" } });
        };
        await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "host", nodeId: 1 }).submitNode(node);
        const compiled = submitted.authoredDetail;
        if (compiled.components[0]?.html !== "<table><tbody><tr><td>Packaged</td></tr></tbody></table>") process.exit(2);
        if (!compiled.components[0]?.css.includes("grid-template-columns:minmax(10rem,1fr) 2fr")) process.exit(3);
        process.stdout.write("packaged graph-client compile passed\\n");
      `;
      const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", probe], {
        cwd: directory,
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(result.stdout).toBe("packaged graph-client compile passed\n");

      const [desktopMain, evalMain] = await Promise.all([
        readFile(resolve("desktop/main/index.mjs"), "utf8"),
        readFile(resolve("desktop/eval-main/index.mjs"), "utf8"),
      ]);
      const exactDynamicPath = 'pathToFileURL(join(process.resourcesPath, "graph-client", "index.js")).href';
      expect(desktopMain).toContain(exactDynamicPath);
      expect(evalMain).toContain(exactDynamicPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphAuthoringWriteError,
  RelayerGraphClient,
  detailCapability,
  html,
  type GraphNode,
  type GraphLayer,
} from "../src/index.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function wire() {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const ids = new Map<string, number>();
  let next = 10;
  const reply = (path: string, body: Record<string, unknown>) => {
    const key = `${path}:${body.clientKey}`;
    const id = ids.get(key) ?? next++;
    ids.set(key, id);
    if (path.endsWith("/nodes"))
      return {
        node: {
          id,
          clientKey: body.clientKey,
          kind: body.kind,
          icon: body.icon,
          title: body.title,
          detail: body.detail,
          state: "draft",
          ...(Object.hasOwn(body, "authoredDetail")
            ? { authoredDetail: body.authoredDetail }
            : {}),
        },
      };
    if (path.endsWith("/edges"))
      return { edge: { id, endpoints: body.endpoints, state: "draft" } };
    if (path.endsWith("/layers"))
      return { layer: { ...body, id, state: "draft" } };
    return { action: { ...body, id } };
  };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ path, body });
    return new Response(JSON.stringify(reply(path, body)));
  });
  vi.stubGlobal("fetch", fetch);
  return { requests, fetch, reply };
}
const client = () =>
  new RelayerGraphClient({
    url: "http://graph.test",
    token: "test",
    nodeId: 1,
  });

describe("scoped graph authoring", () => {
  it("explains rejected node and action identity fields while keeping the draft repairable", () => {
    const layer = client().authoring("repair").layer("answer");
    expect(() => layer.node("finding", Object.assign({ icon: "info", title: "Finding", detail: "Evidence" }, { clientKey: "extra" })))
      .toThrow('Unknown node field "clientKey". Use layer.node(localKey, { icon, title, detail }) with optional kind');
    const node = layer.node("finding", { icon: "info", title: "Finding", detail: "Evidence" });
    expect(() => layer.action("next", node, Object.assign({ kind: "invoke" as const, label: "Next", interactionText: "Next" }, { sourceLayer: layer.object, clientKey: "extra" })))
      .toThrow("Remove sourceLayer, clientKey from layer.action(localKey, sourceNode, fields)");
    const action = layer.action("next", node, { kind: "invoke", label: "Next", interactionText: "Next" });
    expect(action.sourceLayer).toBe(layer.object);
  });

  afterEach(() => vi.unstubAllGlobals());
  it("captures a scoped artifact destination and preserves its canonical node and renderer through queued writes", async () => {
    const fixture = wire();
    const entered = gate();
    const release = gate();
    const fingerprint = "a".repeat(64);
    fixture.fetch.mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      fixture.requests.push({ path, body });
      if (path.endsWith("/nodes")) { entered.release(); await release.promise; }
      const reply = fixture.reply(path, body);
      if ("node" in reply && body.artifact) Object.assign(reply.node, { artifact: { ...body.artifact, fingerprint } });
      return new Response(JSON.stringify(reply));
    });
    const author = client().authoring("artifact-capture");
    const root = author.layer("answer");
    const viewer = author.layer("viewer");
    const summary = root.node("summary", { icon: "info", title: "Site", detail: "Open the site" });
    const artifact = viewer.node("site", { icon: "globe", title: "Site", detail: "Website" });
    const source = { file: "site/index.html", root: "site" };
    artifact.artifact = { kind: "website", source, part: { route: "#pricing" }, viewport: "phone" };
    viewer.object.renderer = "artifact";
    const open = root.action("open", summary, { kind: "navigate", relation: "expand", label: "Open site", target: viewer });
    root.layout([[summary, .5, .5]], { edgeShape: "default" });
    viewer.layout([[artifact, .5, .5]], { edgeShape: "default", defaultNode: artifact });
    const pending = author.write(root);
    await entered.promise;
    source.file = "late/index.html";
    Reflect.set(artifact.artifact, "part", { route: "#late" });
    viewer.object.renderer = undefined;
    release.release();
    const written = await pending;
    const artifactWrite = fixture.requests.find(({ body }) => body.artifact)!;
    expect(artifactWrite.body.artifact).toEqual({ kind: "website", source: { file: "site/index.html", root: "site" }, part: { route: "#pricing" }, viewport: "phone" });
    const viewerWrite = fixture.requests.find(({ path, body }) => path.endsWith("/layers") && body.clientKey === viewer.object.clientKey)!;
    expect(viewerWrite.body).toMatchObject({ renderer: "artifact", nodes: [artifact.ref!.id], defaultNodeId: artifact.ref!.id });
    expect(viewer.object.ref?.renderer).toBe("artifact");
    expect(artifact.ref?.artifact).toEqual({ ...(artifactWrite.body.artifact as object), fingerprint });
    expect(written.actions.find(action => action.clientKey === open.clientKey)?.targetLayerId).toBe(viewer.object.ref!.id);
  });

  it("captures scoped Input bindings before queued transport and writes canonical refs despite later mutation", async () => {
    const fixture = wire();
    const entered = gate();
    const release = gate();
    fixture.fetch.mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      fixture.requests.push({ path, body });
      if (path.endsWith("/nodes")) {
        entered.release();
        await release.promise;
      }
      return new Response(JSON.stringify(fixture.reply(path, body)));
    });
    const author = client().authoring("inputs");
    const layer = author.layer("plan");
    const node = layer.node("plan", { icon: "compass", title: "Plan", detail: "Inputs" });
    const options = [{ key: "lisbon", label: "Lisbon" }];
    const input = layer.action("destination", node, { kind: "input", label: "Destination", control: "single_select", prompt: "Destination", options });
    const invoke = layer.action("analyze", node, { kind: "invoke", label: "Analyze", interactionText: "Analyze", inputActions: [input] });
    layer.layout([[node, .5, .5]], { edgeShape: "default" });
    const pending = author.write(layer);
    await entered.promise;
    options[0]!.label = "Late option";
    Reflect.set(input, "label", "Late Input");
    Reflect.set(input, "sourceLayer", new Object());
    Reflect.set(input, "ref", { id: 999 });
    Reflect.set(invoke, "inputActions", [999]);
    Reflect.set(invoke, "interactionText", "Late instruction");
    release.release();
    const result = await pending;
    const inputWrite = fixture.requests.find(({ body }) => body.kind === "input")!;
    const invocation = fixture.requests.find(({ body }) => body.kind === "invoke")!;
    expect(inputWrite.body).toMatchObject({ label: "Destination", options: [{ key: "lisbon", label: "Lisbon" }] });
    expect(invocation.body.interactionText).toBe("Analyze");
    expect(invocation.body.inputActionIds).toEqual([result.actions.find(action => action.kind === "input")!.id]);
    expect(invocation.body.sourceLayerId).toBe(inputWrite.body.sourceLayerId);
    expect(invocation.body.reusable).toBe(false);
    expect(input.ref?.id).toBe(result.actions.find(action => action.kind === "input")!.id);
  });

  it("binds explicit accepted Input records through their canonical IDs without dependency writes", async () => {
    const fixture = wire();
    const author = client().authoring("accepted-input");
    const layer = author.layer("plan");
    const node = layer.node("plan", { icon: "compass", title: "Plan", detail: "Inputs" });
    const accepted = { id: 99, kind: "input", state: "accepted", sourceNodeId: 10, label: "Destination", variant: "pill", control: "text", prompt: "Destination" } as const;
    layer.action("analyze", node, { kind: "invoke", label: "Analyze", interactionText: "Analyze", inputActions: [accepted] });
    layer.layout([[node, .5, .5]], { edgeShape: "default" });
    const pending = author.write(layer);
    Reflect.set(accepted, "id", 999);
    await pending;
    expect(fixture.requests.filter(({ body }) => body.kind === "input")).toEqual([]);
    expect(fixture.requests.find(({ body }) => body.kind === "invoke")!.body.inputActionIds).toEqual([99]);
  });

  it("rejects forged, cross-source and cross-layer scoped Input declarations before transport", async () => {
    for (const invalidBinding of ["forged", "cross-source", "cross-layer", "changed-layer"] as const) {
      const fixture = wire();
      const author = client().authoring(`invalid-${invalidBinding}`);
      const layer = author.layer("plan");
      const node = layer.node("plan", { icon: "compass", title: "Plan", detail: "Inputs" });
      const input = layer.action("destination", node, { kind: "input", label: "Destination", control: "text", prompt: "Destination" });
      let binding = input;
      if (invalidBinding === "forged") binding = { ...input, ref: { id: 999 } } as typeof input;
      if (invalidBinding === "cross-source") {
        const other = layer.node("other", { icon: "info", title: "Other", detail: "Other" });
        binding = layer.action("other-input", other, { kind: "input", label: "Other", control: "text", prompt: "Other" });
        layer.layout([[node, .2, .5], [other, .8, .5]], { edgeShape: "default" });
      } else layer.layout([[node, .5, .5]], { edgeShape: "default" });
      if (invalidBinding === "cross-layer") {
        const other = author.layer("other");
        const owner = other.node("owner", { icon: "info", title: "Other", detail: "Other" });
        binding = other.action("input", owner, { kind: "input", label: "Other", control: "text", prompt: "Other" });
        other.layout([[owner, .5, .5]], { edgeShape: "default" });
      }
      if (invalidBinding === "changed-layer") Reflect.set(input, "sourceLayer", author.layer("other").object);
      layer.action("analyze", node, { kind: "invoke", label: "Analyze", interactionText: "Analyze", inputActions: [binding] });
      await expect(author.write(layer)).rejects.toThrow(invalidBinding === "changed-layer" ? "containing source layer" : "same source Node and scoped Layer");
      expect(fixture.requests).toEqual([]);
    }
  });

  it("captures a bound two-layer program before queued transport and preserves all selected aliases", async () => {
    const fixture = wire();
    const entered = gate();
    const release = gate();
    fixture.fetch.mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      fixture.requests.push({ path, body });
      if (path.endsWith("/nodes")) {
        entered.release();
        await release.promise;
      }
      return new Response(
        JSON.stringify({
          ...fixture.reply(path, body),
          ...(path.endsWith("/nodes")
            ? { preview: { status: "limit_reached" } }
            : path.endsWith("/layers")
              ? { preview: { status: "failed" } }
              : {}),
        }),
      );
    });
    const graph = client();
    const author = graph.authoring("finding-v1");
    const root = author.layer("answer");
    const evidence = author.layer("evidence");
    const a = root.node("finding", {
      icon: "zap",
      title: "Finding",
      detail: "Supported finding",
    });
    const b = root.node("limitation", {
      icon: "info",
      title: "Limitation",
      detail: "Measured limitation",
    });
    const queued = root.node("next", {
      icon: "check",
      title: "Next",
      detail: "Next step",
    });
    queued.detailAuthoring.setComponent(
      "main",
      html`<p>Original queued detail</p>`,
    );
    const proof = evidence.node("proof", {
      icon: "file",
      title: "Proof",
      detail: "Evidence",
    });
    const edge = root.edge("relationship", a, b);
    const action = root.action("evidence", a, {
      kind: "navigate",
      relation: "expand",
      label: "Evidence",
      target: evidence,
    });
    a.detailAuthoring.setComponent(
      "main",
      html`<button gc=${detailCapability.expand("evidence", action)}>
        Evidence
      </button>`,
    );
    const waypoints = [{ x: 0.4, y: 0.3 }];
    const route = {
      edge,
      ends: [{ node: a }, { node: b }] as const,
      waypoints,
    };
    root.layout(
      [
        [a, 0.2, 0.5],
        [b, 0.5, 0.5],
        [queued, 0.8, 0.5],
      ],
      { edgeShape: "arc-outward", edgeRoutes: [route], defaultNode: a },
    );
    evidence.layout([[proof, 0.5, 0.5]], { edgeShape: "default" });
    const pending = author.write(root);
    await entered.promise;
    const joined = graph.submitNode(queued);
    queued.title = "Late title";
    queued.detailAuthoring.setComponent(
      "main",
      html`<p>Late queued detail</p>`,
    );
    a.title = "Late finding";
    Reflect.set(action, "label", "Late label");
    Reflect.set(action, "target", root.object);
    waypoints[0]!.x = 0.9;
    root.object.layout.placements[0]!.x = 0.9;
    root.object.nodes = [queued];
    edge.endpoints = [queued, a];
    release.release();
    const written = await pending;
    expect(await joined).toBe(
      written.nodes.find((node) => node.clientKey === queued.clientKey),
    );
    const queuedRequest = fixture.requests.find(
      (r) => r.path.endsWith("/nodes") && r.body.clientKey === queued.clientKey,
    )!;
    expect(queuedRequest.body).toMatchObject({
      title: "Next",
      authoredDetail: {
        components: [{ html: "<p>Original queued detail</p>" }],
      },
    });
    const layer = fixture.requests.find(
      (r) =>
        r.path.endsWith("/layers") &&
        r.body.clientKey === root.object.clientKey,
    )!;
    expect(layer.body).toMatchObject({
      nodes: [a.ref!.id, b.ref!.id, queued.ref!.id],
      layout: {
        placements: [{ x: 0.2 }, { x: 0.5 }, { x: 0.8 }],
        edgeRoutes: [{ waypoints: [{ x: 0.4, y: 0.3 }] }],
      },
    });
    expect(
      fixture.requests.find((r) => r.path.endsWith("/actions"))!.body,
    ).toMatchObject({
      clientKey: action.clientKey,
      label: "Evidence",
      sourceNodeId: a.ref!.id,
      sourceLayerId: written.rootLayer.id,
      targetLayerId: evidence.object.ref!.id,
    });
    const mount = a.ref!.authoredDetail!.mounts[0]!;
    if (mount.kind !== "capability")
      throw new Error("Expected a capability mount");
    expect(mount.capability).toMatchObject({
      action: {
        clientKey: action.clientKey,
        sourceNode: { clientKey: a.clientKey },
        sourceLayer: { clientKey: root.object.clientKey },
      },
    });
    expect(written.rootLayer.state).toBe("draft");
    expect(written.rootLayer.preview?.status).toBe("failed");
    expect(
      written.nodes.every((node) => node.preview?.status === "limit_reached"),
    ).toBe(true);
    expect(fixture.requests.map((r) => r.path)).toEqual([
      "/api/graph/nodes",
      "/api/graph/nodes",
      "/api/graph/nodes",
      "/api/graph/nodes",
      "/api/graph/edges",
      "/api/graph/layers",
      "/api/graph/layers",
      "/api/graph/actions",
    ]);
  });

  it("settles started requests, leaves queued requests unscheduled, and repairs with fresh same-key objects", async () => {
    const fixture = wire();
    const entered = gate();
    const release = gate();
    let fail = true;
    let active = 0;
    let maximum = 0;
    fixture.fetch.mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      fixture.requests.push({ path, body });
      active++;
      maximum = Math.max(maximum, active);
      if (fail && body.title === "A") {
        await entered.promise;
        active--;
        return new Response(
          JSON.stringify({
            error: {
              code: "unsupported_icon",
              message: "Use a supported icon",
              issues: [],
            },
          }),
          { status: 422 },
        );
      }
      if (fail && body.title === "B") {
        entered.release();
        await release.promise;
      }
      active--;
      return new Response(JSON.stringify(fixture.reply(path, body)));
    });
    const graph = client();
    const assemble = () => {
      const author = graph.authoring("repair");
      const layer = author.layer("answer");
      const nodes = ["A", "B", "C"].map((title) =>
        layer.node(title, { icon: "box", title, detail: title }),
      );
      layer.layout(
        nodes.map((node, index) => [node, 0.2 + index * 0.3, 0.5] as const),
        { edgeShape: "default" },
      );
      return { author, layer, nodes };
    };
    const first = assemble();
    const pending = first.author.write(first.layer);
    const failure = pending.catch((error) => error);
    await entered.promise;
    const queued = graph.submitNode(first.nodes[2]!);
    const cancelled = expect(queued).rejects.toThrow("not scheduled");
    release.release();
    const error = await failure;
    expect(error).toBeInstanceOf(GraphAuthoringWriteError);
    expect(error).toMatchObject({
      completed: [{ path: 'layers["answer"].nodes["B"]', kind: "node" }],
      failures: [
        {
          path: 'layers["answer"].nodes["A"]',
          outcome: "rejected",
          cause: { code: "unsupported_icon" },
        },
      ],
      unstarted: ['layers["answer"].nodes["C"]', 'layers["answer"]'],
    });
    await cancelled;
    expect(maximum).toBe(2);
    expect(fixture.requests).toHaveLength(2);
    fail = false;
    const repaired = assemble();
    await repaired.author.write(repaired.layer);
    expect(repaired.nodes.map((n) => n.clientKey)).toEqual(
      first.nodes.map((n) => n.clientKey),
    );
    expect(repaired.nodes[1]!.ref!.id).toBe(first.nodes[1]!.ref!.id);
  });

  it("traverses reference cycles once, excludes unrelated declarations, and snapshots accepted membership", async () => {
    const fixture = wire();
    const entered = gate();
    const release = gate();
    fixture.fetch.mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      fixture.requests.push({ path, body });
      if (path.endsWith("/nodes")) {
        entered.release();
        await release.promise;
      }
      return new Response(JSON.stringify(fixture.reply(path, body)));
    });
    const graph = client();
    const author = graph.authoring("references");
    const root = author.layer("answer");
    const left = author.layer("left");
    const right = author.layer("right");
    author.layer("unrelated");
    const accepted: GraphNode = {
      id: 900,
      state: "accepted",
      icon: "file",
      kind: "concept",
      title: "History",
      detail: "Immutable history",
    };
    root.include(accepted);
    const answer = root.node("answer", {
      icon: "info",
      title: "Answer",
      detail: "Answer",
    });
    const l = left.node("left", {
      icon: "info",
      title: "Left",
      detail: "Left",
    });
    const r = right.node("right", {
      icon: "info",
      title: "Right",
      detail: "Right",
    });
    root.edge("history", answer, accepted);
    root.action("context", answer, {
      kind: "navigate",
      relation: "reference",
      label: "Context",
      target: left,
    });
    left.action("next", l, {
      kind: "navigate",
      relation: "reference",
      label: "Next",
      target: right,
    });
    right.action("back", r, {
      kind: "navigate",
      relation: "reference",
      label: "Back",
      target: left,
    });
    root.layout(
      [
        [answer, 0.2, 0.5],
        [accepted, 0.8, 0.5],
      ],
      { edgeShape: "straight" },
    );
    left.layout([[l, 0.5, 0.5]], { edgeShape: "default" });
    right.layout([[r, 0.5, 0.5]], { edgeShape: "default" });
    const acceptedLayer: GraphLayer = {
      id: 901,
      state: "accepted",
      nodes: [],
      edges: [],
    };
    root.action("accepted", answer, {
      kind: "navigate",
      relation: "reference",
      label: "Accepted",
      target: acceptedLayer,
    });
    const options = [{ key: "yes", label: "Original" }];
    root.action("input", answer, {
      kind: "input",
      label: "Choice",
      control: "single_select",
      prompt: "Choose",
      options,
    });
    const pending = author.write(root);
    await entered.promise;
    Reflect.set(acceptedLayer, "id", 999);
    options[0]!.label = "Late";
    Reflect.set(accepted, "id", 999);
    release.release();
    const written = await pending;
    expect(written.layers).toHaveLength(3);
    expect(written.nodes).toHaveLength(3);
    expect(
      fixture.requests.find((r) => r.path.endsWith("/edges"))!.body.endpoints,
    ).toContain(900);
    expect(
      fixture.requests
        .filter((r) => r.path.endsWith("/nodes"))
        .some((r) => r.body.title === "History"),
    ).toBe(false);
    const layer = fixture.requests.find(
      (r) =>
        r.path.endsWith("/layers") &&
        r.body.clientKey === root.object.clientKey,
    )!;
    expect(layer.body.nodes).toContain(900);
    expect(
      fixture.requests.find((item) => item.body.label === "Accepted")!.body
        .targetLayerId,
    ).toBe(901);
    expect(
      fixture.requests.find((item) => item.body.label === "Choice")!.body
        .options,
    ).toEqual([{ key: "yes", label: "Original" }]);
  });
  it("reports compiler and capture errors once, without server or cancellation echoes", async () => {
    const fixture = wire();
    const graph = new RelayerGraphClient({
      url: "http://graph.test",
      token: "test",
      nodeId: 1,
      authoringErrors: true,
    });
    const author = graph.authoring("metric");
    const root = author.layer("answer");
    const bad = root.node("bad", { icon: "info", title: "Bad", detail: "Bad" });
    bad.detailAuthoring.setComponent(
      "main",
      html`<script>
        bad();
      </script>`,
    );
    const good = root.node("good", {
      icon: "info",
      title: "Good",
      detail: "Good",
    });
    const queued = root.node("queued", {
      icon: "info",
      title: "Queued",
      detail: "Queued",
    });
    root.layout(
      [
        [bad, 0.2, 0.5],
        [good, 0.5, 0.5],
        [queued, 0.8, 0.5],
      ],
      { edgeShape: "default" },
    );
    await expect(author.write(root)).rejects.toMatchObject({
      failures: [
        { outcome: "rejected", cause: { name: "DetailCompilationError" } },
      ],
    });
    const reports = () =>
      fixture.requests.filter((item) =>
        item.path.endsWith("/authoring-errors"),
      );
    expect(reports()).toHaveLength(1);
    expect(reports()[0]!.body.phase).toBe("compiler");
    // An unscheduled reservation is repairable and a direct call can start it.
    queued.detailAuthoring.setComponent("main", html`<p>Repaired</p>`);
    await graph.submitNode(queued);
    expect(reports()).toHaveLength(1);
    const unfinished = graph.authoring("unfinished");
    await expect(unfinished.write(unfinished.layer("answer"))).rejects.toThrow(
      "Unfinished layout",
    );
    expect(reports()).toHaveLength(2);
    fixture.fetch.mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      fixture.requests.push({ path, body });
      return path.endsWith("/authoring-errors")
        ? new Response("{}")
        : new Response(
            JSON.stringify({
              error: {
                code: "unsupported_icon",
                message: "Unsupported icon",
                issues: [],
              },
            }),
            { status: 422 },
          );
    });
    const rejected = graph.authoring("server");
    const layer = rejected.layer("answer");
    const node = layer.node("bad", {
      icon: "info",
      title: "Bad",
      detail: "Bad",
    });
    layer.layout([[node, 0.5, 0.5]], { edgeShape: "default" });
    await expect(rejected.write(layer)).rejects.toMatchObject({
      failures: [{ outcome: "rejected", cause: { status: 422 } }],
    });
    expect(reports()).toHaveLength(2);
  });

  it("captures omission versus explicit clear before queued compilation", async () => {
    const fixture = wire();
    const entered = gate();
    const release = gate();
    const graph = client();
    const assemble = () => {
      const author = graph.authoring("clear");
      const layer = author.layer("answer");
      const nodes = ["a", "b", "c"].map((key) =>
        layer.node(key, { icon: "info", title: key, detail: key }),
      );
      layer.layout(
        nodes.map((node, index) => [node, 0.2 + index * 0.3, 0.5] as const),
        { edgeShape: "default" },
      );
      return { author, layer, nodes };
    };
    const old = assemble();
    old.nodes[2]!.detailAuthoring.setComponent(
      "main",
      html`<p>Existing package</p>`,
    );
    const persisted = (await old.author.write(old.layer)).nodes.find(
      (node) => node.clientKey === old.nodes[2]!.clientKey,
    )!;
    fixture.fetch.mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      fixture.requests.push({ path, body });
      if (path.endsWith("/nodes")) {
        entered.release();
        await release.promise;
      }
      const response = fixture.reply(path, body);
      if (
        path.endsWith("/nodes") &&
        body.clientKey === persisted.clientKey &&
        !Object.hasOwn(body, "authoredDetail")
      )
        Object.assign(response.node!, {
          authoredDetail: persisted.authoredDetail,
        });
      return new Response(JSON.stringify(response));
    });
    const next = assemble();
    const pending = next.author.write(next.layer);
    await entered.promise;
    next.nodes[2]!.detailAuthoring.clear();
    release.release();
    const written = await pending;
    expect(
      written.nodes.find((node) => node.clientKey === persisted.clientKey)!
        .authoredDetail,
    ).toEqual(persisted.authoredDetail);
    expect(
      Object.hasOwn(
        fixture.requests
          .filter(
            (item) =>
              item.path.endsWith("/nodes") &&
              item.body.clientKey === persisted.clientKey,
          )
          .at(-1)!.body,
        "authoredDetail",
      ),
    ).toBe(false);
  });
  it("joins an existing direct node submission and rejects unsafe preflight data before transport", async () => {
    const fixture = wire();
    const entered = gate();
    const release = gate();
    fixture.fetch.mockImplementation(async (url, init) => {
      const requestPath = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      fixture.requests.push({ path: requestPath, body });
      if (requestPath.endsWith("/nodes")) {
        entered.release();
        await release.promise;
      }
      return new Response(JSON.stringify(fixture.reply(requestPath, body)));
    });
    const graph = client();
    const author = graph.authoring("direct");
    const layer = author.layer("answer");
    const node = layer.node("a", {
      icon: "info",
      title: "Original",
      detail: "Original",
    });
    layer.layout([[node, 0.5, 0.5]], { edgeShape: "default" });
    const direct = graph.submitNode(node);
    await entered.promise;
    node.title = "Late";
    const pending = author.write(layer);
    release.release();
    const written = await pending;
    expect(await direct).toBe(written.nodes[0]);
    expect(written.nodes[0]!.title).toBe("Original");
    expect(
      fixture.requests.filter((item) => item.path.endsWith("/nodes")),
    ).toHaveLength(1);
    const requests = fixture.requests.length;
    const invalid = graph.authoring("unsafe");
    const invalidLayer = invalid.layer("answer");
    const a = invalidLayer.node("a", { icon: "info", title: "A", detail: "A" });
    invalidLayer.layout([[a, 0.5, 0.5]], { edgeShape: "default" });
    const getter = vi.fn(() => 0.8);
    Object.defineProperty(invalidLayer.object.layout.placements[0], "x", {
      get: getter,
    });
    await expect(invalid.write(invalidLayer)).rejects.toThrow("accessors");
    expect(getter).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(requests);
    expect(() => graph.authoring("long".repeat(50)).layer("answer")).toThrow(
      "128 UTF-8 bytes",
    );
    const changed = graph.authoring("direct");
    const repair = changed.layer("answer");
    const fresh = repair.node("a", { icon: "info", title: "A", detail: "A" });
    const b = repair.node("b", { icon: "info", title: "B", detail: "B" });
    repair.edge("connection", fresh, b);
    repair.layout(
      [
        [fresh, 0.2, 0.5],
        [b, 0.8, 0.5],
      ],
      { edgeShape: "default" },
    );
    await changed.write(repair);
    const drift = graph.authoring("direct");
    const driftLayer = drift.layer("answer");
    const fa = driftLayer.node("a", { icon: "info", title: "A", detail: "A" });
    const c = driftLayer.node("c", { icon: "info", title: "C", detail: "C" });
    driftLayer.edge("connection", fa, c);
    driftLayer.layout(
      [
        [fa, 0.2, 0.5],
        [c, 0.8, 0.5],
      ],
      { edgeShape: "default" },
    );
    const before = fixture.requests.length;
    await expect(drift.write(driftLayer)).rejects.toThrow(
      "identity-owning context",
    );
    expect(fixture.requests).toHaveLength(before);
  });
});

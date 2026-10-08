import { isProxy } from "node:util/types";
import { observeAuthoringMethods } from "./authoring-errors.js";
import { DetailCompilationError } from "./detail.js";
import type { WithGraphPreview } from "./client.js";
import type { GraphIcon } from "./image-icons.js";
import {
  EdgeObject,
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  type ActionObject,
  type EdgeEndObject,
  type EdgeReference,
  type EdgeRouteObject,
  type LayerReference,
  type NodeReference,
} from "./objects.js";
import type { EdgeShape } from "./edge-shapes.js";
import {
  GraphApiError,
  type GraphAction,
  type GraphCapability,
  type GraphEdge,
  type GraphLayer,
  type GraphNode,
} from "./types.js";

/** Private client seam: a captured node still uses the client's compiler and retry state. */
export interface CapturedNodeWrite {
  readonly run: () => Promise<WithGraphPreview<GraphNode>>;
  readonly cancel: (reason: Error) => void;
}

interface AuthoringTransport {
  captureNode(node: NodeObject): CapturedNodeWrite;
  rememberIdentity(key: string, context: string): void;
  claimWrites(keys: readonly string[]): () => void;
  createEdge(edge: EdgeObject): Promise<GraphEdge>;
  submitLayer(
    layer: LayerObject,
    options: { readonly sizeJustification?: string },
  ): Promise<WithGraphPreview<GraphLayer>>;
  addAction(
    source: NodeReference,
    original: ActionObject,
    captured: ActionObject,
  ): Promise<GraphAction>;
  reportCaptureError(error: unknown): void;
}

export interface AuthoringNodeFields {
  readonly icon: GraphIcon;
  readonly title: string;
  readonly detail: string;
  readonly kind?: string;
}
export type AuthoringActionFields =
  | (Omit<
      Extract<ActionObject, { kind: "navigate" }>,
      "sourceLayer" | "clientKey" | "ref" | "target"
    > & { readonly target: ScopedAuthoringLayer | LayerReference })
  | Omit<
      Extract<ActionObject, { kind: "invoke" }>,
      "sourceLayer" | "clientKey" | "ref"
    >
  | Omit<
      Extract<ActionObject, { kind: "input" }>,
      "sourceLayer" | "clientKey" | "ref"
    >;
type ScopedActionObject<T extends AuthoringActionFields> = ActionObject &
  Pick<T, "kind"> &
  (T extends { readonly relation: infer R }
    ? { readonly relation: R }
    : unknown);
export interface AuthoringLayoutOptions {
  readonly edgeShape: EdgeShape;
  readonly edgeRoutes?: readonly EdgeRouteObject[];
  readonly defaultNode?: NodeReference;
  readonly sizeJustification?: string | undefined;
}

export interface GraphWriteResult {
  /** A draft write result, not an acceptance receipt or content lock. */
  readonly rootLayer: WithGraphPreview<GraphLayer>;
  readonly nodes: readonly WithGraphPreview<GraphNode>[];
  readonly edges: readonly GraphEdge[];
  readonly layers: readonly WithGraphPreview<GraphLayer>[];
  readonly actions: readonly GraphAction[];
}
export interface CompletedAuthoringWrite {
  readonly path: string;
  readonly kind: "node" | "edge" | "layer" | "action";
  readonly id: number;
}
export interface FailedAuthoringWrite {
  readonly path: string;
  readonly outcome: "rejected" | "unknown";
  readonly cause: unknown;
}
export class GraphAuthoringValidationError extends Error {
  override readonly name = "GraphAuthoringValidationError";
}
export class GraphAuthoringWriteError extends Error {
  override readonly name = "GraphAuthoringWriteError";
  constructor(
    readonly completed: readonly CompletedAuthoringWrite[],
    readonly failures: readonly FailedAuthoringWrite[],
    readonly unstarted: readonly string[],
  ) {
    super(
      `Scoped graph write failed at ${failures.map((failure) => failure.path).join(", ")}; valid drafts are retained.`,
      { cause: failures[0]?.cause },
    );
  }
}

/** Versioned, lossless encoding. Shorten names rather than silently hashing oversized identities. */
function identity(
  snapshot: string,
  layer: string,
  kind: string,
  local: string,
): string {
  const key = `ga1:${Buffer.from(JSON.stringify([snapshot, layer, kind, local]), "utf8").toString("base64url")}`;
  if (Buffer.byteLength(key) > 128)
    invalid(
      "Scoped identity exceeds 128 UTF-8 bytes; shorten the snapshot, layer, or local name.",
    );
  return key;
}
function name(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    invalid(
      "Authoring names must be nonempty, trimmed, NUL-free Unicode strings.",
    );
  return value;
}
function invalid(message: string): never {
  throw new GraphAuthoringValidationError(message);
}
function data(value: object, prototype?: object): Record<string, unknown> {
  if (
    isProxy(value) ||
    ![
      Object.prototype,
      null,
      ...(prototype === undefined ? [] : [prototype]),
    ].includes(Object.getPrototypeOf(value))
  )
    invalid("Authoring fields must be ordinary own data properties.");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !("value" in descriptor))
      invalid("Authoring fields cannot contain accessors or symbols.");
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
    });
  }
  return result;
}
function array<T>(value: readonly T[]): T[] {
  if (
    !Array.isArray(value) ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    invalid("Authoring arrays must be ordinary data.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || !("value" in descriptors[key]!))),
    )
  )
    invalid(
      "Authoring arrays cannot contain accessors, symbols, or extra properties.",
    );
  return Array.from({ length: value.length }, (_, index) => {
    const item = descriptors[String(index)];
    if (item === undefined || !("value" in item))
      invalid("Authoring arrays cannot contain holes or accessors.");
    return item.value as T;
  });
}
function copyValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value))
      invalid("Authoring values cannot contain cycles.");
    ancestors.add(value);
    try {
      if (Array.isArray(value))
        return array(value).map((item) => copyValue(item, ancestors));
      return Object.fromEntries(
        Object.entries(data(value)).map(([key, item]) => [
          key,
          copyValue(item, ancestors),
        ]),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  if (["function", "symbol", "bigint"].includes(typeof value))
    invalid(
      "Authoring values must be data, not factories or executable properties.",
    );
  return value;
}
function path(layer: string, kind: string, local = ""): string {
  return `layers[${JSON.stringify(layer)}]${local ? `.${kind}[${JSON.stringify(local)}]` : ""}`;
}
function referenceIdentity(node: NodeReference): string {
  if (node instanceof NodeObject) return `key:${node.clientKey}`;
  return `id:${typeof node === "number" ? node : node.id}`;
}
function ends(
  ends: readonly [EdgeEndObject, EdgeEndObject],
  resolve: (node: NodeReference) => NodeReference,
): readonly [EdgeEndObject, EdgeEndObject] {
  const captured = array(ends);
  if (captured.length !== 2) invalid("A route must declare exactly two ends.");
  const copy = (end: EdgeEndObject): EdgeEndObject => {
    data(end);
    return {
      node: resolve(end.node),
      ...(end.side === undefined ? {} : { side: end.side }),
    };
  };
  return [copy(captured[0]!), copy(captured[1]!)];
}
function freezeRecord<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeRecord(item);
    Object.freeze(value);
  }
  return value;
}

interface LayerDeclaration {
  readonly object: LayerObject;
  readonly name: string;
  readonly nodes: Map<string, NodeObject>;
  readonly edges: Map<string, EdgeObject>;
  readonly endpoints: Map<EdgeObject, readonly [NodeReference, NodeReference]>;
  readonly actions: Map<
    string,
    { readonly source: NodeObject; readonly action: ActionObject }
  >;
  readonly members: NodeReference[];
  readonly connections: EdgeReference[];
  ready: boolean;
  sizeJustification?: string | undefined;
}

export class ScopedAuthoringLayer {
  readonly #owner: ScopedGraphAuthoring;
  readonly #declaration: LayerDeclaration;
  constructor(owner: ScopedGraphAuthoring, declaration: LayerDeclaration) {
    this.#owner = owner;
    this.#declaration = declaration;
  }
  /** The actual containing object used by bound visual actions. */
  get object(): LayerObject {
    return this.#declaration.object;
  }
  node(localKey: string, fields: AuthoringNodeFields): NodeObject {
    const key = name(localKey);
    const declaration = this.#declaration;
    if (declaration.nodes.has(key))
      invalid(`Duplicate node ${path(declaration.name, "nodes", key)}.`);
    const values = data(fields);
    const unknownField = Object.keys(values).find(
      (field) => !["icon", "title", "detail", "kind"].includes(field),
    );
    if (unknownField !== undefined)
      invalid(`Unknown node field ${JSON.stringify(unknownField.slice(0, 128))}. Use layer.node(localKey, { icon, title, detail }) with optional kind; the scoped API supplies clientKey and ref.`);
    if (
      typeof values.title !== "string" ||
      typeof values.detail !== "string" ||
      (values.kind !== undefined && typeof values.kind !== "string")
    )
      invalid("Node title/detail and optional kind must be strings.");
    const node = new NodeObject(
      values.icon as GraphIcon,
      values.title,
      values.detail,
      values.kind,
      identity(this.#owner.snapshotKey, declaration.name, "n", key),
    );
    declaration.nodes.set(key, node);
    declaration.members.push(node);
    declaration.object.nodes = [...declaration.members];
    return node;
  }
  include(record: GraphNode | GraphEdge): void {
    const fields = data(record);
    if (
      fields.state !== "accepted" ||
      !Number.isSafeInteger(fields.id) ||
      Number(fields.id) < 1
    )
      invalid(
        "include requires an explicit accepted node or edge; it never resubmits drafts.",
      );
    const members = Object.hasOwn(fields, "endpoints")
      ? this.#declaration.connections
      : this.#declaration.members;
    if (
      members.some(
        (item) =>
          !(item instanceof NodeObject) &&
          !(item instanceof EdgeObject) &&
          typeof item !== "number" &&
          item.id === record.id,
      )
    )
      invalid("Duplicate accepted membership.");
    if (Object.hasOwn(fields, "endpoints"))
      this.#declaration.connections.push(record as GraphEdge);
    else this.#declaration.members.push(record as GraphNode);
    this.#declaration.object.nodes = [...this.#declaration.members];
    this.#declaration.object.edges = [...this.#declaration.connections];
  }
  edge(
    localKey: string,
    left: NodeReference,
    right: NodeReference,
  ): EdgeObject {
    const key = name(localKey);
    const declaration = this.#declaration;
    if (declaration.edges.has(key))
      invalid(`Duplicate edge ${path(declaration.name, "edges", key)}.`);
    if (
      !declaration.members.includes(left) ||
      !declaration.members.includes(right)
    )
      invalid(
        "Edge endpoints must be explicit members of their containing layer.",
      );
    const edge = new EdgeObject(
      [left, right],
      identity(this.#owner.snapshotKey, declaration.name, "e", key),
    );
    declaration.edges.set(key, edge);
    declaration.endpoints.set(edge, [left, right]);
    declaration.connections.push(edge);
    declaration.object.edges = [...declaration.connections];
    return edge;
  }
  action<T extends AuthoringActionFields>(
    localKey: string,
    source: NodeObject,
    fields: T,
  ): ScopedActionObject<T> {
    const key = name(localKey);
    const declaration = this.#declaration;
    if (declaration.actions.has(key))
      invalid(`Duplicate action ${path(declaration.name, "actions", key)}.`);
    if (
      !declaration.members.includes(source) ||
      ![...declaration.nodes.values()].includes(source)
    )
      invalid("An action needs its exact declared owning node in this layer.");
    const values = data(fields);
    const reservedFields = ["sourceLayer", "clientKey", "ref"].filter((field) => Object.hasOwn(values, field));
    if (reservedFields.length > 0)
      invalid(`Remove ${reservedFields.join(", ")} from layer.action(localKey, sourceNode, fields). The scoped module supplies action identity and source provenance; pass the returned action unchanged to detailCapability.`);
    const action = {
      ...values,
      ...(values.kind === "navigate"
        ? {
            target:
              values.target instanceof ScopedAuthoringLayer
                ? values.target.object
                : values.target,
          }
        : {}),
      sourceLayer: declaration.object,
      clientKey: identity(this.#owner.snapshotKey, declaration.name, "a", key),
    } as ActionObject;
    declaration.actions.set(key, { source, action });
    return action as ScopedActionObject<T>;
  }
  layout(
    placements: readonly (readonly [NodeReference, number, number])[],
    options: AuthoringLayoutOptions,
  ): void {
    const declaration = this.#declaration;
    declaration.object.layout = new LayerLayoutObject(
      placements.map(([node, x, y]) => new NodePlacementObject(node, x, y)),
      options.edgeShape,
      options.edgeRoutes ?? [],
    );
    declaration.object.defaultNode = options.defaultNode;
    declaration.sizeJustification = options.sizeJustification;
    declaration.ready = true;
  }
}

interface Job {
  readonly path: string;
  readonly kind: CompletedAuthoringWrite["kind"];
  readonly run: () => Promise<{ readonly id: number }>;
}
interface CapturedLayer {
  readonly declaration: LayerDeclaration;
  readonly clientKey: string;
  readonly nodes: readonly NodeReference[];
  readonly edges: readonly EdgeReference[];
  readonly layout: LayerLayoutObject;
  readonly defaultNode?: NodeReference | undefined;
  readonly sizeJustification?: string | undefined;
}

export class ScopedGraphAuthoring {
  readonly #layers = new Map<string, LayerDeclaration>();
  readonly #objects = new Map<LayerObject, LayerDeclaration>();
  #writing = false;
  readonly #snapshotKey: string;
  readonly #capability: GraphCapability;
  readonly #transport: AuthoringTransport;
  get snapshotKey(): string {
    return this.#snapshotKey;
  }
  constructor(
    snapshotKey: string,
    capability: GraphCapability,
    transport: AuthoringTransport,
  ) {
    this.#snapshotKey = name(snapshotKey);
    this.#capability = capability;
    this.#transport = transport;
  }
  layer(localKey: string): ScopedAuthoringLayer {
    const key = name(localKey);
    if (this.#layers.has(key)) invalid(`Duplicate layer ${key}.`);
    const members: NodeReference[] = [];
    const connections: EdgeReference[] = [];
    const object = new LayerObject(
      [...members],
      [...connections],
      new LayerLayoutObject([], "default"),
      identity(this.snapshotKey, key, "l", ""),
    );
    const declaration: LayerDeclaration = {
      object,
      name: key,
      nodes: new Map(),
      edges: new Map(),
      endpoints: new Map(),
      actions: new Map(),
      members,
      connections,
      ready: false,
    };
    this.#layers.set(key, declaration);
    this.#objects.set(object, declaration);
    return observeAuthoringMethods(
      new ScopedAuthoringLayer(this, declaration),
      this.#capability,
      (error) => error instanceof GraphApiError,
    );
  }

  async write(root: ScopedAuthoringLayer): Promise<GraphWriteResult> {
    if (this.#writing)
      invalid(
        "A scoped write is already running; await it before repairing this snapshot.",
      );
    const selectedRoot = this.#objects.get(root.object);
    if (!selectedRoot)
      invalid("The root must be a layer declared by this authoring scope.");
    this.#writing = true;
    const reservations: CapturedNodeWrite[] = [];
    const completed: CompletedAuthoringWrite[] = [];
    const failures: FailedAuthoringWrite[] = [];
    const unstarted: string[] = [];
    let releaseWrites: (() => void) | undefined;
    try {
      // Everything up to the first stage await is captured, including all detail programs.
      const layers: CapturedLayer[] = [];
      const actionDeclarations: {
        source: NodeObject;
        original: ActionObject;
        captured: ActionObject;
        path: string;
      }[] = [];
      const acceptedNodes = new Map<NodeReference, number>();
      const acceptedEdges = new Map<EdgeReference, number>();
      const visited = new Set<LayerObject>();
      const visit = (declaration: LayerDeclaration) => {
        if (visited.has(declaration.object)) return;
        visited.add(declaration.object);
        data(declaration.object, LayerObject.prototype);
        if (!declaration.ready)
          invalid(`Unfinished layout at ${path(declaration.name, "")}.`);
        if (
          declaration.object.clientKey !==
          identity(this.snapshotKey, declaration.name, "l", "")
        )
          invalid("A declared layer identity changed.");
        if (
          array(declaration.object.nodes).length !==
            declaration.members.length ||
          array(declaration.object.nodes).some(
            (node, index) => node !== declaration.members[index],
          ) ||
          array(declaration.object.edges).length !==
            declaration.connections.length ||
          array(declaration.object.edges).some(
            (edge, index) => edge !== declaration.connections[index],
          )
        )
          invalid("Use declarations to change layer membership.");
        const nodes = [...declaration.members];
        const edges = [...declaration.connections];
        for (const reference of nodes)
          if (!(reference instanceof NodeObject)) {
            if (typeof reference === "number")
              invalid("Accepted membership needs an explicit accepted record.");
            const fields = data(reference);
            if (
              fields.state !== "accepted" ||
              !Number.isSafeInteger(fields.id) ||
              Number(fields.id) < 1
            )
              invalid("Accepted node membership changed before capture.");
            acceptedNodes.set(reference, Number(fields.id));
          }
        for (const reference of edges)
          if (!(reference instanceof EdgeObject)) {
            if (typeof reference === "number")
              invalid("Accepted membership needs an explicit accepted record.");
            const fields = data(reference);
            if (
              fields.state !== "accepted" ||
              !Number.isSafeInteger(fields.id) ||
              Number(fields.id) < 1
            )
              invalid("Accepted edge membership changed before capture.");
            acceptedEdges.set(reference, Number(fields.id));
          }
        const layout = declaration.object.layout;
        data(layout, LayerLayoutObject.prototype);
        const placements = array(layout.placements).map((placement) => {
          data(placement, NodePlacementObject.prototype);
          return new NodePlacementObject(
            placement.node,
            placement.x,
            placement.y,
          );
        });
        if (
          placements.length !== nodes.length ||
          new Set(placements.map((placement) => placement.node)).size !==
            nodes.length ||
          placements.some(
            (placement) =>
              !nodes.includes(placement.node) ||
              !Number.isFinite(placement.x) ||
              !Number.isFinite(placement.y) ||
              placement.x < 0 ||
              placement.x > 1 ||
              placement.y < 0 ||
              placement.y > 1,
          )
        )
          invalid(
            `Layout needs one explicit normalized placement per member at ${path(declaration.name, "")}.`,
          );
        if (
          declaration.object.defaultNode !== undefined &&
          !nodes.includes(declaration.object.defaultNode)
        )
          invalid("The default node must be an explicit layer member.");
        const routes = array(layout.edgeRoutes).map((route) => {
          data(route);
          return {
            edge: route.edge,
            ...(route.shape === undefined ? {} : { shape: route.shape }),
            ...(route.ends === undefined
              ? {}
              : { ends: ends(route.ends, (node) => node) }),
            ...(route.waypoints === undefined
              ? {}
              : {
                  waypoints: array(route.waypoints).map((point) => {
                    data(point);
                    return { x: point.x, y: point.y };
                  }),
                }),
          };
        });
        if (
          routes.some(
            (route) =>
              !edges.includes(route.edge) ||
              route.ends?.some((end) => !nodes.includes(end.node)),
          )
        )
          invalid("Route edges and ends must be explicit layer members.");
        layers.push({
          declaration,
          clientKey: declaration.object.clientKey,
          nodes,
          edges,
          layout: new LayerLayoutObject(placements, layout.edgeShape, routes),
          defaultNode: declaration.object.defaultNode,
          sizeJustification: declaration.sizeJustification,
        });
        for (const [key, node] of declaration.nodes)
          if (
            isProxy(node) ||
            !(
              "value" in
              (Object.getOwnPropertyDescriptor(node, "clientKey") ?? {})
            ) ||
            node.clientKey !==
              identity(this.snapshotKey, declaration.name, "n", key)
          )
            invalid("A declared node identity changed.");
        for (const [key, edge] of declaration.edges) {
          data(edge, EdgeObject.prototype);
          const endpoints = declaration.endpoints.get(edge)!;
          if (
            edge.clientKey !==
              identity(this.snapshotKey, declaration.name, "e", key) ||
            edge.endpoints[0] !== endpoints[0] ||
            edge.endpoints[1] !== endpoints[1]
          )
            invalid("Changed edge endpoints require a new edge key.");
          this.#transport.rememberIdentity(
            edge.clientKey,
            JSON.stringify(endpoints.map(referenceIdentity).sort()),
          );
        }
        for (const [key, { source, action }] of declaration.actions) {
          const fields = data(action);
          if (
            fields.clientKey !==
              identity(this.snapshotKey, declaration.name, "a", key) ||
            fields.sourceLayer !== declaration.object
          )
            invalid(
              "Repair must retain the action's original identity and containing source layer.",
            );
          this.#transport.rememberIdentity(
            String(fields.clientKey),
            JSON.stringify([declaration.object.clientKey, source.clientKey]),
          );
          const target =
            fields.kind === "navigate"
              ? (fields.target as LayerReference)
              : undefined;
          let acceptedTarget: GraphLayer | undefined;
          if (target instanceof LayerObject) {
            const child = this.#objects.get(target);
            if (!child)
              invalid(
                "Navigation targets must be declared in this scope or explicitly accepted layers.",
              );
            visit(child);
          } else if (fields.kind === "navigate") {
            if (typeof target !== "object" || target === null)
              invalid(
                "A navigation target must be a declared layer or an explicit accepted layer record.",
              );
            const targetFields = data(target);
            if (
              targetFields.state !== "accepted" ||
              !Number.isSafeInteger(targetFields.id) ||
              Number(targetFields.id) < 1
            )
              invalid("Navigation needs an explicit accepted layer record.");
            acceptedTarget = {
              ...targetFields,
              id: Number(targetFields.id),
            } as unknown as GraphLayer;
          }
          const inputActions = fields.kind === "invoke" ? array((fields.inputActions ?? []) as readonly unknown[]).map((reference) => {
            if (typeof reference === "number") {
              if (!Number.isSafeInteger(reference) || reference < 1) invalid("Input action ID must be positive.");
              return reference;
            }
            const declared = [...declaration.actions.values()].find(candidate => candidate.action === reference);
            if (!declared || declared.source !== source || declared.action.kind !== "input")
              invalid("Invoke Inputs must be declared on the same source Node and scoped Layer.");
            const input = data(declared.action);
            return { ...Object.fromEntries(Object.entries(input).filter(([field]) => !["sourceLayer", "ref"].includes(field)).map(([field, value]) => [field, copyValue(value)])), sourceLayer: declaration.object } as ActionObject;
          }) : undefined;
          const copied = Object.fromEntries(
            Object.entries(fields)
              .filter(
                ([field]) => !["sourceLayer", "target", "ref", "inputActions"].includes(field),
              )
              .map(([field, value]) => [field, copyValue(value)]),
          );
          actionDeclarations.push({
            source,
            original: action,
            captured: {
              ...copied,
              sourceLayer: declaration.object,
              ...(inputActions === undefined ? {} : { inputActions }),
              ...(target === undefined
                ? {}
                : {
                    target:
                      target instanceof LayerObject ? target : acceptedTarget!,
                  }),
            } as ActionObject,
            path: path(declaration.name, "actions", key),
          });
        }
      };
      visit(selectedRoot);
      releaseWrites = this.#transport.claimWrites(
        layers.flatMap(({ declaration }) => [
          declaration.object.clientKey,
          ...[...declaration.nodes.values()].map((node) => node.clientKey),
          ...[...declaration.edges.values()].map((edge) => edge.clientKey),
          ...[...declaration.actions.values()].map(
            ({ action }) => action.clientKey!,
          ),
        ]),
      );
      const nodeResults = new Map<NodeObject, WithGraphPreview<GraphNode>>();
      const edgeResults = new Map<EdgeObject, GraphEdge>();
      const layerResults = new Map<LayerObject, WithGraphPreview<GraphLayer>>();
      const actionResults: GraphAction[] = [];
      const nodeRef = (reference: NodeReference): NodeReference =>
        nodeResults.has(reference as NodeObject)
          ? nodeResults.get(reference as NodeObject)!
          : acceptedNodes.get(reference)!;
      const edgeRef = (reference: EdgeReference): EdgeReference =>
        edgeResults.has(reference as EdgeObject)
          ? edgeResults.get(reference as EdgeObject)!
          : acceptedEdges.get(reference)!;
      const stages: Job[][] = [[], [], [], []];
      for (const { declaration } of layers) {
        for (const [key, node] of declaration.nodes) {
          const reservation = this.#transport.captureNode(node);
          reservations.push(reservation);
          stages[0]!.push({
            path: path(declaration.name, "nodes", key),
            kind: "node",
            run: async () => {
              const value = freezeRecord(await reservation.run());
              nodeResults.set(node, value);
              return value;
            },
          });
        }
        for (const [key, edge] of declaration.edges) {
          data(edge, EdgeObject.prototype);
          const endpoints = declaration.endpoints.get(edge)!;
          const capturedKey = edge.clientKey;
          stages[1]!.push({
            path: path(declaration.name, "edges", key),
            kind: "edge",
            run: async () => {
              const value = freezeRecord(
                await this.#transport.createEdge(
                  new EdgeObject(
                    [nodeRef(endpoints[0]), nodeRef(endpoints[1])],
                    capturedKey,
                  ),
                ),
              );
              edgeResults.set(edge, value);
              edge.ref = value;
              return value;
            },
          });
        }
      }
      for (const capture of layers)
        stages[2]!.push({
          path: path(capture.declaration.name, ""),
          kind: "layer",
          run: async () => {
            const layout = new LayerLayoutObject(
              capture.layout.placements.map(
                (placement) =>
                  new NodePlacementObject(
                    nodeRef(placement.node),
                    placement.x,
                    placement.y,
                  ),
              ),
              capture.layout.edgeShape,
              capture.layout.edgeRoutes.map((route) => ({
                ...route,
                edge: edgeRef(route.edge),
                ...(route.ends === undefined
                  ? {}
                  : { ends: ends(route.ends, nodeRef) }),
              })),
            );
            const value = freezeRecord(
              await this.#transport.submitLayer(
                new LayerObject(
                  capture.nodes.map(nodeRef),
                  capture.edges.map(edgeRef),
                  layout,
                  capture.clientKey,
                  capture.defaultNode === undefined
                    ? undefined
                    : nodeRef(capture.defaultNode),
                ),
                capture.sizeJustification === undefined
                  ? {}
                  : { sizeJustification: capture.sizeJustification },
              ),
            );
            layerResults.set(capture.declaration.object, value);
            capture.declaration.object.ref = value;
            return value;
          },
        });
      for (const capture of actionDeclarations)
        stages[3]!.push({
          path: capture.path,
          kind: "action",
          run: async () => {
            const action = capture.captured;
            const sourceLayer = layerResults.get(
              action.sourceLayer as LayerObject,
            )!;
            const fields: ActionObject =
              action.kind === "navigate"
                ? {
                    ...action,
                    sourceLayer,
                    target: layerResults.has(action.target as LayerObject)
                      ? layerResults.get(action.target as LayerObject)!
                      : action.target,
                  }
                : { ...action, sourceLayer, ...(action.kind === "invoke" ? { inputActions: (action.inputActions ?? []).map(input => typeof input === "number" || "id" in input ? input : { ...input, sourceLayer }) } : {}) };
            const value = freezeRecord(
              await this.#transport.addAction(
                nodeRef(capture.source),
                capture.original,
                fields,
              ),
            );
            actionResults.push(value);
            return value;
          },
        });
      for (const [index, stage] of stages.entries()) {
        let cursor = 0;
        const worker = async () => {
          while (!failures.length && cursor < stage.length) {
            const job = stage[cursor++]!;
            try {
              const value = await job.run();
              if (!Number.isSafeInteger(value.id) || value.id < 1)
                throw new Error("Write response lacks a valid record identity");
              completed.push({ path: job.path, kind: job.kind, id: value.id });
            } catch (cause) {
              const rejected =
                cause instanceof GraphAuthoringValidationError ||
                cause instanceof DetailCompilationError ||
                (cause instanceof GraphApiError &&
                  cause.status >= 400 &&
                  cause.status < 500);
              failures.push({
                path: job.path,
                outcome: rejected ? "rejected" : "unknown",
                cause,
              });
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(2, stage.length) }, worker),
        );
        if (failures.length) {
          unstarted.push(
            ...stage.slice(cursor).map((job) => job.path),
            ...stages
              .slice(index + 1)
              .flat()
              .map((job) => job.path),
          );
          throw new GraphAuthoringWriteError(completed, failures, unstarted);
        }
      }
      return Object.freeze({
        rootLayer: layerResults.get(selectedRoot.object)!,
        nodes: Object.freeze([...nodeResults.values()]),
        edges: Object.freeze([...edgeResults.values()]),
        layers: Object.freeze([...layerResults.values()]),
        actions: Object.freeze(actionResults),
      });
    } catch (error) {
      if (!(error instanceof GraphAuthoringWriteError))
        this.#transport.reportCaptureError(error);
      const cancelled = new Error(
        "Captured node write was not scheduled because the scoped write failed.",
      );
      for (const reservation of reservations) reservation.cancel(cancelled);
      throw error;
    } finally {
      releaseWrites?.();
      this.#writing = false;
    }
  }
}

/** Not exported by either public entry point; only the client supplies the submission seam. */
export function createScopedGraphAuthoring(
  snapshotKey: string,
  capability: GraphCapability,
  transport: AuthoringTransport,
): ScopedGraphAuthoring {
  return observeAuthoringMethods(
    new ScopedGraphAuthoring(snapshotKey, capability, transport),
    capability,
    (error) =>
      error instanceof GraphApiError ||
      error instanceof GraphAuthoringWriteError,
  );
}

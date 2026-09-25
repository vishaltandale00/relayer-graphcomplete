const EXPORT_VERSION = 1;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
const MAX_TURNS = 10_000;
const MAX_LAYERS_PER_TURN = 10_000;
const MAX_NODES_PER_LAYER = 8;
const MAX_EDGES_PER_LAYER = 28;
const MAX_ACTIONS_PER_LAYER = 64;
const MAX_STRING_BYTES = 4 * 1024 * 1024;

const COMPLETION_STATUSES = new Set([
  "not_started",
  "running",
  "submitted",
  "waiting_for_approval",
  "accepted",
  "failed",
  "stopped",
]);
const ACTION_KINDS = new Set(["navigate", "invoke", "input"]);
const NAVIGATION_RELATIONS = new Set(["expand", "reference"]);
const ACTION_VARIANTS = new Set(["chip", "pill", "wide", "card"]);

/**
 * A public-share parse failure is deliberately typed so the HTTP/Electron
 * boundary can turn malformed or unsafe bytes into the same render failure
 * without exposing parser internals or source content to the visitor.
 */
export class PublicSnapshotError extends Error {
  constructor(code, path, message) {
    super(`${message} (${path})`);
    this.name = "PublicSnapshotError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new PublicSnapshotError(code, path, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail("record_invalid", path, "Expected an object.");
  return value;
}

function requireArray(value, path) {
  if (!Array.isArray(value)) fail("array_invalid", path, "Expected an array.");
  return value;
}

function utf8Length(value) {
  return new TextEncoder().encode(value).length;
}

function requireString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    fail("string_invalid", path, "Expected a non-empty string.");
  }
  if (utf8Length(value) > MAX_STRING_BYTES) {
    fail("string_too_large", path, "String exceeds the V1 string limit.");
  }
  return value;
}

function optionalString(value, path) {
  if (value == null) return null;
  return requireString(value, path);
}

function requirePortableId(value, kind, path) {
  requireString(value, path);
  if (
    value.length > 128
    || !new RegExp(`^${kind}:[A-Za-z0-9._-]+$`).test(value)
  ) {
    fail("portable_id_invalid", path, `Expected an authority-free ${kind}:<local-id> identifier.`);
  }
  return value;
}

function requireInteger(value, path, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("integer_invalid", path, `Expected a safe integer >= ${minimum}.`);
  }
  return value;
}

function own(value, key, path) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    fail("field_missing", path, `Missing required field ${key}.`);
  }
  return value[key];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(",")}}`;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function decodeUtf8(input) {
  if (typeof input === "string") return input;
  if (input instanceof ArrayBuffer) {
    input = new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (bytes.byteLength > MAX_EXPORT_BYTES) fail("file_too_large", "file", "Snapshot exceeds the V1 file limit.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      fail("utf8_invalid", "file", `Snapshot is not valid UTF-8: ${error.message}`);
    }
  }
  fail("input_invalid", "file", "Snapshot input must be UTF-8 text or bytes.");
}

function parseJsonl(input) {
  const source = decodeUtf8(input);
  if (utf8Length(source) > MAX_EXPORT_BYTES) {
    fail("file_too_large", "file", "Snapshot exceeds the V1 file limit.");
  }
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) fail("header_required", "record[0]", "The snapshot is empty.");
  return lines.map((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) fail("empty_line", `line[${lineNumber}]`, "JSONL lines may not be empty.");
    if (utf8Length(line) > MAX_JSONL_LINE_BYTES) {
      fail("line_too_large", `line[${lineNumber}]`, "JSONL line exceeds the V1 line limit.");
    }
    try {
      return JSON.parse(line);
    } catch (error) {
      fail("json_invalid", `line[${lineNumber}]`, `Invalid JSON: ${error.message}`);
    }
  });
}

function validateProducer(producer) {
  requireRecord(producer, "header.producer");
  for (const field of ["desktopVersion", "buildCommit", "platform", "architecture"]) {
    requireString(own(producer, field, `header.producer.${field}`), `header.producer.${field}`);
  }
}

function validateHeader(header) {
  requireRecord(header, "record[0]");
  if (header.recordType !== "header") {
    fail("header_required", "record[0].recordType", "The first JSONL record must be a header.");
  }
  if (header.exportVersion !== EXPORT_VERSION) {
    fail("unsupported_export_version", "header.exportVersion", "Only conversation export V1 is supported.");
  }
  requireString(own(header, "exportedAt", "header.exportedAt"), "header.exportedAt");
  validateProducer(own(header, "producer", "header.producer"));
  const conversation = requireRecord(own(header, "conversation", "header.conversation"), "header.conversation");
  requirePortableId(own(conversation, "id", "header.conversation.id"), "conversation", "header.conversation.id");
  requireString(own(conversation, "title", "header.conversation.title"), "header.conversation.title");
  requireString(own(conversation, "createdAt", "header.conversation.createdAt"), "header.conversation.createdAt");
  if (conversation.projectName != null) requireString(conversation.projectName, "header.conversation.projectName");
  requireString(
    own(conversation, "harnessConfigurationName", "header.conversation.harnessConfigurationName"),
    "header.conversation.harnessConfigurationName",
  );
  requireString(
    own(conversation, "permissionProfileId", "header.conversation.permissionProfileId"),
    "header.conversation.permissionProfileId",
  );
  const manifest = requireArray(own(header, "turns", "header.turns"), "header.turns");
  if (!manifest.length || manifest.length > MAX_TURNS) {
    fail("turn_count_out_of_bounds", "header.turns", "A V1 snapshot must declare 1 to 10,000 turns.");
  }
  const ids = new Set();
  manifest.forEach((entry, index) => {
    const path = `header.turns[${index}]`;
    const item = requireRecord(entry, path);
    const id = requirePortableId(own(item, "id", `${path}.id`), "turn", `${path}.id`);
    if (ids.has(id)) fail("duplicate_turn_id", `${path}.id`, `Turn ID ${id} appears more than once.`);
    ids.add(id);
    const sequence = requireInteger(own(item, "sequence", `${path}.sequence`), `${path}.sequence`, { minimum: 1 });
    if (sequence !== index + 1) fail("turn_sequence_invalid", `${path}.sequence`, "Turn sequences must be contiguous from one.");
  });
  return { conversation, manifest };
}

function validateOrigin(origin, path) {
  const value = requireRecord(origin, path);
  const kind = requireString(own(value, "kind", `${path}.kind`), `${path}.kind`);
  if (kind === "user") return { kind };
  if (kind === "action") {
    const hasCamel = Object.prototype.hasOwnProperty.call(value, "sourceTurnId")
      || Object.prototype.hasOwnProperty.call(value, "sourceActionId");
    const hasSnake = Object.prototype.hasOwnProperty.call(value, "source_turn_id")
      || Object.prototype.hasOwnProperty.call(value, "source_action_id");
    if (hasCamel && hasSnake) fail("origin_invalid", path, "Action origin fields use mixed naming.");
    return {
      kind,
      sourceTurnId: requirePortableId(
        own(value, hasSnake ? "source_turn_id" : "sourceTurnId", `${path}.sourceTurnId`),
        "turn",
        `${path}.sourceTurnId`,
      ),
      sourceActionId: requirePortableId(
        own(value, hasSnake ? "source_action_id" : "sourceActionId", `${path}.sourceActionId`),
        "action",
        `${path}.sourceActionId`,
      ),
    };
  }
  fail("origin_invalid", `${path}.kind`, "Origin kind must be user or action.");
}

function validateCompletion(completion, path) {
  const value = requireRecord(completion, path);
  const status = requireString(own(value, "status", `${path}.status`), `${path}.status`);
  if (!COMPLETION_STATUSES.has(status)) fail("completion_status_invalid", `${path}.status`, "Unknown completion status.");
  requireString(own(value, "permissionProfileId", `${path}.permissionProfileId`), `${path}.permissionProfileId`);
  if (value.harnessConfigurationName != null) optionalString(value.harnessConfigurationName, `${path}.harnessConfigurationName`);
  if (value.modelSelection != null) {
    const selection = requireRecord(value.modelSelection, `${path}.modelSelection`);
    requireString(own(selection, "providerId", `${path}.modelSelection.providerId`), `${path}.modelSelection.providerId`);
    requireString(own(selection, "modelId", `${path}.modelSelection.modelId`), `${path}.modelSelection.modelId`);
    requireInteger(own(selection, "modelFamilyId", `${path}.modelSelection.modelFamilyId`), `${path}.modelSelection.modelFamilyId`, { minimum: 1 });
  }
  return status;
}

function validateAction(action, path, { sourceLayerRequired = false } = {}) {
  const value = requireRecord(action, path);
  requirePortableId(own(value, "id", `${path}.id`), "action", `${path}.id`);
  requirePortableId(own(value, "sourceNodeId", `${path}.sourceNodeId`), "node", `${path}.sourceNodeId`);
  if (value.sourceLayerId != null) requirePortableId(value.sourceLayerId, "layer", `${path}.sourceLayerId`);
  if (sourceLayerRequired && value.sourceLayerId == null) {
    fail("action_source_layer_missing", `${path}.sourceLayerId`, "Resolved actions require source-layer provenance.");
  }
  const kind = requireString(own(value, "kind", `${path}.kind`), `${path}.kind`);
  if (!ACTION_KINDS.has(kind)) fail("action_kind_invalid", `${path}.kind`, "Unknown action kind.");
  const label = requireString(own(value, "label", `${path}.label`), `${path}.label`);
  const variant = requireString(own(value, "variant", `${path}.variant`), `${path}.variant`);
  if (!ACTION_VARIANTS.has(variant)) fail("action_variant_invalid", `${path}.variant`, "Unknown action variant.");
  if (value.clientKey != null) requireString(value.clientKey, `${path}.clientKey`);
  if (value.icon != null) requireString(value.icon, `${path}.icon`);
  if (value.description != null) requireString(value.description, `${path}.description`);
  if (kind === "navigate") {
    const relation = requireString(own(value, "relation", `${path}.relation`), `${path}.relation`);
    if (!NAVIGATION_RELATIONS.has(relation)) fail("navigate_relation_invalid", `${path}.relation`, "Unknown navigation relation.");
    requirePortableId(own(value, "targetLayerId", `${path}.targetLayerId`), "layer", `${path}.targetLayerId`);
    if (value.interactionText != null || value.input != null) fail("action_shape_invalid", path, "Navigate actions cannot carry invoke or input fields.");
  } else if (kind === "invoke") {
    requireString(own(value, "interactionText", `${path}.interactionText`), `${path}.interactionText`);
    if (value.relation != null || value.targetLayerId != null || value.input != null) fail("action_shape_invalid", path, "Invoke actions cannot carry navigation or input fields.");
  } else {
    requireRecord(own(value, "input", `${path}.input`), `${path}.input`);
    if (value.relation != null || value.targetLayerId != null || value.interactionText != null) fail("action_shape_invalid", path, "Input actions cannot carry navigation or invoke fields.");
  }
  if (variant === "card" && (!value.description || value.description.trim() === "")) {
    fail("card_description_missing", `${path}.description`, "Card actions require a description.");
  }
  if (variant !== "card" && value.description != null) {
    fail("action_description_unexpected", `${path}.description`, "Only card actions may contain a description.");
  }
  return value;
}

function validateLayer(resolved, path, allDefinitions) {
  const value = requireRecord(resolved, path);
  const layer = requireRecord(own(value, "layer", `${path}.layer`), `${path}.layer`);
  const layerId = requirePortableId(own(layer, "id", `${path}.layer.id`), "layer", `${path}.layer.id`);
  requireString(own(layer, "state", `${path}.layer.state`), `${path}.layer.state`);
  if (layer.state !== "accepted") fail("layer_state_invalid", `${path}.layer.state`, "Public snapshots may contain accepted layers only.");
  if (layer.clientKey != null) requireString(layer.clientKey, `${path}.layer.clientKey`);
  const nodes = requireArray(own(value, "nodes", `${path}.nodes`), `${path}.nodes`);
  const edges = requireArray(own(value, "edges", `${path}.edges`), `${path}.edges`);
  const actions = requireArray(own(value, "actions", `${path}.actions`), `${path}.actions`);
  if (!nodes.length || nodes.length > MAX_NODES_PER_LAYER) fail("layer_node_count", `${path}.nodes`, "A layer must contain one to eight nodes.");
  if (edges.length > MAX_EDGES_PER_LAYER || actions.length > MAX_ACTIONS_PER_LAYER) fail("layer_member_limit", path, "Layer edge or action count exceeds the V1 bound.");
  const memberNodeIds = nodes.map((node, index) => {
    const nodePath = `${path}.nodes[${index}]`;
    const item = requireRecord(node, nodePath);
    const id = requirePortableId(own(item, "id", `${nodePath}.id`), "node", `${nodePath}.id`);
    for (const field of ["kind", "icon", "title", "detail"]) requireString(own(item, field, `${nodePath}.${field}`), `${nodePath}.${field}`, { allowEmpty: field === "detail" });
    requireString(own(item, "state", `${nodePath}.state`), `${nodePath}.state`);
    if (item.state !== "accepted") fail("node_state_invalid", `${nodePath}.state`, "Public snapshots may contain accepted nodes only.");
    if (item.clientKey != null) requireString(item.clientKey, `${nodePath}.clientKey`);
    if (item.authoredDetail != null && item.authoredDetailOmitted != null) fail("authored_detail_conflict", nodePath, "A node cannot carry an authored detail and an omission reason.");
    const previous = allDefinitions.nodes.get(id);
    const fingerprint = stableJson(item);
    if (previous && previous !== fingerprint) fail("node_identity_conflict", `${nodePath}.id`, "A portable node ID has conflicting definitions.");
    allDefinitions.nodes.set(id, fingerprint);
    return id;
  });
  const memberNodeSet = new Set(memberNodeIds);
  if (!Array.isArray(layer.nodes) || layer.nodes.length !== memberNodeIds.length || layer.nodes.some((id, index) => id !== memberNodeIds[index])) {
    fail("layer_membership_mismatch", `${path}.layer.nodes`, "Layer node membership must match resolved node order.");
  }
  const memberEdgeIds = edges.map((edge, index) => {
    const edgePath = `${path}.edges[${index}]`;
    const item = requireRecord(edge, edgePath);
    const id = requirePortableId(own(item, "id", `${edgePath}.id`), "edge", `${edgePath}.id`);
    const endpoints = requireArray(own(item, "endpoints", `${edgePath}.endpoints`), `${edgePath}.endpoints`);
    if (endpoints.length !== 2) fail("edge_endpoints_invalid", `${edgePath}.endpoints`, "Edges require two endpoints.");
    endpoints.forEach((endpoint, endpointIndex) => {
      requirePortableId(endpoint, "node", `${edgePath}.endpoints[${endpointIndex}]`);
      if (!memberNodeSet.has(endpoint)) fail("edge_outside_layer", `${edgePath}.endpoints`, "An edge must connect nodes in its layer.");
    });
    if (endpoints[0] === endpoints[1]) fail("edge_outside_layer", `${edgePath}.endpoints`, "An edge cannot connect a node to itself.");
    requireString(own(item, "state", `${edgePath}.state`), `${edgePath}.state`);
    if (item.state !== "accepted") fail("edge_state_invalid", `${edgePath}.state`, "Public snapshots may contain accepted edges only.");
    const previous = allDefinitions.edges.get(id);
    const fingerprint = stableJson(item);
    if (previous && previous !== fingerprint) fail("edge_identity_conflict", `${edgePath}.id`, "A portable edge ID has conflicting definitions.");
    allDefinitions.edges.set(id, fingerprint);
    return id;
  });
  if (!Array.isArray(layer.edges) || layer.edges.length !== memberEdgeIds.length || layer.edges.some((id, index) => id !== memberEdgeIds[index])) {
    fail("layer_membership_mismatch", `${path}.layer.edges`, "Layer edge membership must match resolved edge order.");
  }
  const seenActionIds = new Set();
  actions.forEach((action, index) => {
    const actionPath = `${path}.actions[${index}]`;
    const item = validateAction(action, actionPath, { sourceLayerRequired: true });
    if (seenActionIds.has(item.id)) fail("duplicate_action_id", actionPath, "An action appears more than once in one layer.");
    seenActionIds.add(item.id);
    if (!memberNodeSet.has(item.sourceNodeId)) fail("action_source_outside_layer", `${actionPath}.sourceNodeId`, "An action source must be a member of its layer.");
    const previous = allDefinitions.actions.get(item.id);
    const fingerprint = stableJson(item);
    if (previous && previous !== fingerprint) fail("action_identity_conflict", `${actionPath}.id`, "A portable action ID has conflicting definitions.");
    allDefinitions.actions.set(item.id, fingerprint);
  });
  if (layer.layout != null) {
    const layout = requireRecord(layer.layout, `${path}.layer.layout`);
    if (layout.version !== 1) fail("unsupported_layout_version", `${path}.layer.layout.version`, "Only layout version 1 is supported.");
    const placements = requireArray(own(layout, "placements", `${path}.layer.layout.placements`), `${path}.layer.layout.placements`);
    if (placements.length !== memberNodeIds.length) fail("layout_placement_count", `${path}.layer.layout.placements`, "A layout requires exactly one placement per node.");
    const placed = new Set();
    placements.forEach((placement, index) => {
      const placementPath = `${path}.layer.layout.placements[${index}]`;
      const item = requireRecord(placement, placementPath);
      const nodeId = requirePortableId(own(item, "nodeId", `${placementPath}.nodeId`), "node", `${placementPath}.nodeId`);
      if (!memberNodeSet.has(nodeId) || placed.has(nodeId)) fail("layout_node_invalid", `${placementPath}.nodeId`, "A layout must place each layer node once.");
      placed.add(nodeId);
      for (const coordinate of ["x", "y"]) {
        const point = item[coordinate];
        if (typeof point !== "number" || !Number.isFinite(point) || point < 0 || point > 1) fail("layout_coordinate_invalid", `${placementPath}.${coordinate}`, "Layout coordinates must be finite numbers from zero through one.");
      }
    });
  }
  return { layerId, value, actions };
}

function validateAcceptedView(view, path) {
  const value = requireRecord(view, path);
  const interactionNodeId = requirePortableId(own(value, "interactionNodeId", `${path}.interactionNodeId`), "node", `${path}.interactionNodeId`);
  const rootLayerId = requirePortableId(own(value, "rootLayerId", `${path}.rootLayerId`), "layer", `${path}.rootLayerId`);
  const rootAction = validateAction(own(value, "rootAction", `${path}.rootAction`), `${path}.rootAction`);
  if (rootAction.sourceNodeId !== interactionNodeId || rootAction.sourceLayerId != null || rootAction.kind !== "navigate" || rootAction.relation !== "expand" || rootAction.targetLayerId !== rootLayerId) {
    fail("invalid_root_action", `${path}.rootAction`, "The root action must be an expand from the interaction node to rootLayerId.");
  }
  const layers = requireArray(own(value, "layers", `${path}.layers`), `${path}.layers`);
  if (!layers.length || layers.length > MAX_LAYERS_PER_TURN) fail("layer_count_out_of_bounds", `${path}.layers`, "An accepted view must contain one to 10,000 layers.");
  const definitions = { nodes: new Map(), edges: new Map(), actions: new Map() };
  const layerMap = new Map();
  const validated = layers.map((resolved, index) => validateLayer(resolved, `${path}.layers[${index}]`, definitions));
  validated.forEach(({ layerId, value }) => {
    if (layerMap.has(layerId)) fail("duplicate_layer_id", `${path}.layers`, `Layer ${layerId} appears more than once.`);
    layerMap.set(layerId, value);
  });
  if (!layerMap.has(rootLayerId)) fail("root_layer_missing", `${path}.rootLayerId`, "The root layer is absent.");
  const pending = [rootLayerId];
  const visited = new Set();
  const targetRelations = new Map([[rootLayerId, "expand"]]);
  const expandEdges = new Map();
  while (pending.length) {
    const layerId = pending.shift();
    if (visited.has(layerId)) continue;
    visited.add(layerId);
    const resolved = layerMap.get(layerId);
    for (const action of resolved.actions) {
      if (action.id === rootAction.id) fail("root_action_repeated", `${path}.actions`, "The root action must not appear in a resolved layer.");
      if (targetRelations.has(action.targetLayerId) && targetRelations.get(action.targetLayerId) !== action.relation) {
        fail("mixed_target_relations", `${path}.actions`, "A layer cannot be targeted as both expand and reference.");
      }
      if (action.kind !== "navigate") continue;
      if (!layerMap.has(action.targetLayerId)) fail("navigate_target_unresolved", `${path}.actions`, `Navigate target ${action.targetLayerId} is absent.`);
      targetRelations.set(action.targetLayerId, action.relation);
      pending.push(action.targetLayerId);
      if (action.relation === "expand") {
        const targets = expandEdges.get(layerId) ?? [];
        targets.push(action.targetLayerId);
        expandEdges.set(layerId, targets);
      }
    }
  }
  if (visited.size !== layerMap.size) fail("incomplete_navigation_closure", `${path}.layers`, "Every resolved layer must be reachable from the root.");
  const cycleCheck = (layerId, visiting = new Set(), visitedLayers = new Set()) => {
    if (visiting.has(layerId)) return true;
    if (visitedLayers.has(layerId)) return false;
    visiting.add(layerId);
    for (const target of expandEdges.get(layerId) ?? []) {
      if (cycleCheck(target, visiting, visitedLayers)) return true;
    }
    visiting.delete(layerId);
    visitedLayers.add(layerId);
    return false;
  };
  if (cycleCheck(rootLayerId)) fail("expand_cycle", `${path}.layers`, "Expand navigation must be acyclic.");
  return value;
}

function normalizeLayer(resolved) {
  const layer = cloneJson(resolved.layer);
  return {
    layer,
    nodes: cloneJson(resolved.nodes),
    edges: cloneJson(resolved.edges),
    actions: cloneJson(resolved.actions),
  };
}

function interactionFromTurn(turn, threadId) {
  const view = turn.acceptedView;
  const rootLayer = view.layers.find(({ layer }) => layer.id === view.rootLayerId);
  const contexts = (turn.contexts ?? []).map((context) => ({
    id: context.id,
    target: {
      nodeId: context.target.id,
      sourceInteractionNodeId: context.source.interactionNodeId,
      sourceLayerId: context.source.layerId,
    },
    targetNode: cloneJson(context.target),
    annotations: cloneJson(context.annotations ?? []),
  }));
  return {
    id: turn.id,
    threadId,
    sequence: turn.sequence,
    text: turn.text,
    createdAt: turn.createdAt,
    graphNodeId: view.interactionNodeId,
    origin: cloneJson(turn.origin),
    contexts,
    submittedInputs: cloneJson(turn.submittedInputs ?? []),
    completionStatus: turn.completion.status,
    harnessConfigurationName: turn.completion.harnessConfigurationName ?? null,
    modelSelection: cloneJson(turn.completion.modelSelection ?? null),
    permissionProfileId: turn.completion.permissionProfileId,
    completionOutput: {
      nodeId: view.interactionNodeId,
      rootAction: cloneJson(view.rootAction),
      rootLayer: normalizeLayer(rootLayer),
    },
  };
}

function publicTurnRecord(turn) {
  const completion = turn.completion;
  return {
    recordType: "turn",
    id: turn.id,
    sequence: turn.sequence,
    createdAt: turn.createdAt,
    text: turn.text,
    ...(turn.interactionNodeId ? { interactionNodeId: turn.interactionNodeId } : {}),
    origin: cloneJson(turn.origin),
    ...(turn.contexts?.length ? { contexts: cloneJson(turn.contexts) } : {}),
    ...(turn.submittedInputs?.length ? { submittedInputs: cloneJson(turn.submittedInputs) } : {}),
    completion: {
      status: completion.status,
      permissionProfileId: completion.permissionProfileId,
      ...(completion.harnessConfigurationName
        ? { harnessConfigurationName: completion.harnessConfigurationName }
        : {}),
      ...(completion.modelSelection ? { modelSelection: cloneJson(completion.modelSelection) } : {}),
    },
    acceptedView: completion.status === "accepted" ? cloneJson(turn.acceptedView) : null,
  };
}

function validateTurn(turn, path, manifestEntry) {
  const value = requireRecord(turn, path);
  if (value.recordType !== "turn") fail("record_type_invalid", `${path}.recordType`, "Every record after the header must be a turn.");
  const id = requirePortableId(own(value, "id", `${path}.id`), "turn", `${path}.id`);
  if (id !== manifestEntry.id) fail("turn_manifest_mismatch", `${path}.id`, "Turn ID does not match the header manifest.");
  const sequence = requireInteger(own(value, "sequence", `${path}.sequence`), `${path}.sequence`, { minimum: 1 });
  if (sequence !== manifestEntry.sequence) fail("turn_manifest_mismatch", `${path}.sequence`, "Turn sequence does not match the header manifest.");
  requireString(own(value, "createdAt", `${path}.createdAt`), `${path}.createdAt`);
  requireString(own(value, "text", `${path}.text`), `${path}.text`, { allowEmpty: true });
  if (value.interactionNodeId != null) requirePortableId(value.interactionNodeId, "node", `${path}.interactionNodeId`);
  validateOrigin(own(value, "origin", `${path}.origin`), `${path}.origin`);
  const status = validateCompletion(own(value, "completion", `${path}.completion`), `${path}.completion`);
  if (!Object.prototype.hasOwnProperty.call(value, "acceptedView")) fail("field_missing", `${path}.acceptedView`, "Every V1 turn must declare acceptedView.");
  if (status === "accepted" && !value.acceptedView) fail("accepted_view_missing", `${path}.acceptedView`, "An accepted turn must include its immutable accepted view.");
  if (status !== "accepted" && value.acceptedView != null) fail("accepted_view_unexpected", `${path}.acceptedView`, "Only accepted turns may include an accepted view.");
  if (value.contexts != null) requireArray(value.contexts, `${path}.contexts`);
  if (value.submittedInputs != null) requireArray(value.submittedInputs, `${path}.submittedInputs`);
  if (status === "accepted") {
    const view = validateAcceptedView(value.acceptedView, `${path}.acceptedView`);
    if (value.interactionNodeId != null && value.interactionNodeId !== view.interactionNodeId) {
      fail("interaction_node_mismatch", `${path}.interactionNodeId`, "Turn interactionNodeId must match acceptedView.interactionNodeId.");
    }
    value.interactionNodeId ??= view.interactionNodeId;
  }
  return value;
}

function publicState(snapshot) {
  const thread = snapshot.thread;
  const acceptedInteractions = snapshot.interactions;
  const first = acceptedInteractions[0];
  const project = snapshot.projectName
    ? { id: "export:project", name: snapshot.projectName }
    : null;
  return {
    projects: project ? [project] : [],
    threads: [thread],
    interactions: acceptedInteractions,
    actionInvocations: [],
    pendingActionInvocations: [],
    approvals: [],
    permissionProfiles: [],
    defaultPermissionProfileId: thread.permissionProfileId,
    modelSettings: {
      defaults: { harnessId: thread.harnessConfigurationName },
      harnesses: [{ id: thread.harnessConfigurationName, label: thread.harnessConfigurationName, available: true }],
      providers: [],
      families: [],
    },
    capabilities: { annotations: false },
    currentInteractionId: first?.id ?? null,
    nodes: first?.completionOutput?.rootLayer?.nodes ?? [],
    edges: first?.completionOutput?.rootLayer?.edges ?? [],
    actions: first?.completionOutput?.rootLayer?.actions ?? [],
    visibleLayer: first?.completionOutput?.rootLayer ?? null,
    status: first?.completionStatus ?? "idle",
    environment: project ? {
      projectId: project.id,
      status: "ready",
      snapshot: {
        kind: "folder",
        worktreeLabel: project.name,
        observedAt: snapshot.header.exportedAt,
      },
    } : null,
    currentProjectionCursor: 0,
    currentProjections: new Map(),
    temporalSafeReason: null,
    temporalLifecycle: null,
  };
}

/**
 * Parse the Rust conversation-export V1 JSONL contract and return the safe
 * read model consumed by the public viewer. Non-accepted turns remain in
 * `turns` for diagnostics but are never placed in `interactions`.
 */
export function parseConversationExportV1(input) {
  const records = parseJsonl(input);
  const header = records[0];
  const { conversation, manifest } = validateHeader(header);
  if (records.slice(1).some((record) => record?.recordType === "header")) {
    fail("header_repeated", "records", "A V1 snapshot may contain only one header.");
  }
  if (records.length - 1 !== manifest.length) {
    fail("turn_count_mismatch", "records", "Turn records must match the header manifest exactly.");
  }
  const turns = records.slice(1).map((turn, index) => validateTurn(turn, `turn[${index}]`, manifest[index]));
  const threadId = `export:${conversation.id}`;
  const acceptedTurns = turns.filter((turn) => turn.completion.status === "accepted");
  if (!acceptedTurns.length) fail("accepted_turn_required", "turns", "A public snapshot must contain at least one accepted turn.");
  const interactions = acceptedTurns.map((turn) => interactionFromTurn(turn, threadId));
  const layersByTurn = new Map(interactions.map((interaction) => [
    String(interaction.id),
    new Map([[String(interaction.completionOutput.rootLayer.layer.id), interaction.completionOutput.rootLayer]]),
  ]));
  for (const interaction of interactions) {
    const sourceTurn = acceptedTurns.find((turn) => String(turn.id) === String(interaction.id));
    const layers = sourceTurn.acceptedView.layers.map(normalizeLayer);
    layersByTurn.set(String(interaction.id), new Map(layers.map((layer) => [String(layer.layer.id), layer])));
  }
  const projectName = conversation.projectName ?? null;
  const projectId = projectName ? "export:project" : null;
  const thread = {
    id: threadId,
    title: conversation.title,
    projectId,
    rootInteractionId: interactions[0]?.id ?? null,
    harnessConfigurationName: conversation.harnessConfigurationName,
    harnessId: conversation.harnessConfigurationName,
    permissionProfileId: conversation.permissionProfileId,
    createdAt: conversation.createdAt,
    updatedAt: turns.at(-1)?.createdAt ?? conversation.createdAt,
    imported: false,
    active: true,
  };
  const snapshot = {
    header: cloneJson(header),
    turns: turns.map(publicTurnRecord),
    acceptedTurns: acceptedTurns.map(publicTurnRecord),
    interactions,
    layersByTurn,
    thread,
    projectName,
    state: null,
    layerFor(turnId, layerId) {
      return layersByTurn.get(String(turnId))?.get(String(layerId)) ?? null;
    },
    turnContainingLayer(layerId) {
      return interactions.find((interaction) => layersByTurn.get(String(interaction.id))?.has(String(layerId))) ?? null;
    },
  };
  snapshot.state = publicState(snapshot);
  return Object.freeze(snapshot);
}

export const parsePublicSnapshot = parseConversationExportV1;

export const publicSnapshotLimits = Object.freeze({
  maxExportBytes: MAX_EXPORT_BYTES,
  maxJsonlLineBytes: MAX_JSONL_LINE_BYTES,
  maxTurns: MAX_TURNS,
  maxLayersPerTurn: MAX_LAYERS_PER_TURN,
});

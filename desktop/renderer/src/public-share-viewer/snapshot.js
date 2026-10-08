import { MAX_EDGE_ROUTE_WAYPOINTS } from "../product-workspace/edge-shapes.js";

const EXPORT_VERSIONS = new Set([1, 2, 3, 4]);
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
const MAX_TURNS = 10_000;
const MAX_LAYERS_PER_TURN = 10_000;
const MAX_NODES_PER_LAYER = 8;
const MAX_EDGES_PER_LAYER = 28;
const MAX_ACTIONS_PER_LAYER = 64;
const MAX_STRING_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BASE64_LENGTH = 4 * Math.ceil(MAX_ASSET_BYTES / 3);
const SAFE_ASSET_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml"]);

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

function requireAssetContentString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    fail("string_invalid", path, "Expected non-empty visual asset content.");
  }
  if (value.length > MAX_ASSET_BASE64_LENGTH) {
    fail("asset_too_large", path, "Encoded visual asset exceeds the public viewer limit.");
  }
  return value;
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
  if (!EXPORT_VERSIONS.has(header.exportVersion)) {
    fail("unsupported_export_version", "header.exportVersion", "Only conversation export V1 through V4 are supported.");
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

function decodeAssetContent(record, path) {
  const value = requireRecord(record, path);
  if (value.recordType !== "visualAssetContent") fail("record_type_invalid", `${path}.recordType`, "Expected visual asset content.");
  const digestSha256 = requireString(own(value, "digestSha256", `${path}.digestSha256`), `${path}.digestSha256`);
  if (!/^[a-f0-9]{64}$/u.test(digestSha256)) fail("asset_digest_invalid", `${path}.digestSha256`, "Visual asset digest is invalid.");
  const mediaType = requireString(own(value, "mediaType", `${path}.mediaType`), `${path}.mediaType`);
  if (!SAFE_ASSET_MEDIA_TYPES.has(mediaType)) fail("asset_media_invalid", `${path}.mediaType`, "Visual asset media type is unsupported.");
  const byteLength = requireInteger(own(value, "byteLength", `${path}.byteLength`), `${path}.byteLength`, { minimum: 1 });
  if (byteLength > MAX_ASSET_BYTES) fail("asset_too_large", `${path}.byteLength`, "Visual asset exceeds the public viewer limit.");
  const contentBase64 = requireAssetContentString(
    own(value, "contentBase64", `${path}.contentBase64`),
    `${path}.contentBase64`,
  );
  if (contentBase64.length !== 4 * Math.ceil(byteLength / 3) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(contentBase64)) {
    fail("asset_content_invalid", `${path}.contentBase64`, "Visual asset content is not canonical base64.");
  }
  const decoded = atob(contentBase64);
  if (decoded.length !== byteLength || btoa(decoded) !== contentBase64) {
    fail("asset_length_mismatch", path, "Visual asset content length does not match its record.");
  }
  return Object.freeze({ digestSha256, mediaType, byteLength, contentBase64 });
}

function validatedIcon(value, path) {
  if (typeof value === "string") return requireString(value, path);
  const icon = requireRecord(value, path);
  if (icon.kind !== "image") fail("icon_invalid", path, "Unsupported icon reference.");
  requireString(icon.assetId, `${path}.assetId`);
  if (!/^[a-f0-9]{64}$/u.test(icon.digestSha256 ?? "") || !SAFE_ASSET_MEDIA_TYPES.has(icon.mediaType)
    || (icon.fit != null && !["contain", "cover"].includes(icon.fit))
    || (icon.framing != null && !["none", "circle", "rounded"].includes(icon.framing))
    || Object.keys(icon).some(key => !["kind", "assetId", "digestSha256", "mediaType", "fit", "framing"].includes(key))) {
    fail("icon_invalid", path, "Image icons require a valid accepted pin and presentation.");
  }
  return icon;
}
function iconAssetPin(value) {
  if (value?.kind !== "image") return null;
  return { id: value.assetId, digestSha256: value.digestSha256, mediaType: value.mediaType, representation: "image" };
}

function validateAssetAssociations(turns, contentByDigest, invocations, boundInputs) {
  const associations = new Map();
  const referencedDigests = new Set();
  function verifyPin(pin, association) {
    if (!association || !pin || pin.id !== association.assetId || pin.digestSha256 !== association.digestSha256 || pin.mediaType !== association.mediaType) {
      fail("asset_inventory_mismatch", "iconAsset", "Image icon association does not match its pin.");
    }
    const content = contentByDigest.get(association.digestSha256);
    if (!content || content.mediaType !== association.mediaType || content.byteLength !== association.byteLength) fail("asset_inventory_mismatch", "iconAsset", "Image icon bytes are missing or inconsistent.");
    requireRecord(association.provenance, "iconAsset.provenance");
    requireString(association.provenance.fileName, "iconAsset.provenance.fileName");
    if (!["user", "system"].includes(association.provenance.source)) fail("asset_provenance_invalid", "iconAsset.provenance.source", "Invalid image provenance.");
    referencedDigests.add(pin.digestSha256);
    associations.set(`${pin.id}\0${pin.digestSha256}\0${pin.mediaType}`, content);
  }
  for (const call of invocations) {
    const pin = iconAssetPin(call.source.icon);
    if (!call.source.iconAssetOmitted && (pin || call.source.iconAsset)) verifyPin(pin, call.source.iconAsset);
  }
  const projections = [...turns, ...invocations.filter(call => call.current).map(call => ({ sequence: 0, acceptedView: { layers: call.current.layers } }))];
  for (const turn of projections) {
    for (const context of turn.contexts ?? []) {
      const pin = iconAssetPin(context.target?.icon);
      if (pin || context.target?.iconAsset) verifyPin(pin, context.target?.iconAsset);
    }
    const rootAction = turn.acceptedView?.rootAction;
    const rootPin = iconAssetPin(rootAction?.icon);
    if (rootPin || rootAction?.iconAsset) verifyPin(rootPin, rootAction?.iconAsset);
    for (const layer of turn.acceptedView?.layers ?? []) {
      if (layer.actions.some(action => action.iconAsset != null)) fail("unexpected_icon_asset", "actions.iconAsset", "Layer action images use source-node associations.");
      for (const node of layer.nodes ?? []) {
        const boundPins = boundInputs.filter(action => action.sourceNodeId === node.id).map(action => iconAssetPin(action.icon)).filter(pin => pin && (node.authoredDetailAssets ?? []).some(association => association.assetId === pin.id && association.digestSha256 === pin.digestSha256 && association.mediaType === pin.mediaType));
        const allPins = [...(node.authoredDetail?.assets ?? []), iconAssetPin(node.icon),
          ...boundPins,
          ...turn.acceptedView.layers.flatMap(layer => layer.actions).filter(action => action.sourceNodeId === node.id).map(action => iconAssetPin(action.icon))].filter(Boolean);
        const unique = new Map();
        for (const pin of allPins) {
          const previous = unique.get(pin.id);
          if (previous && (previous.digestSha256 !== pin.digestSha256 || previous.mediaType !== pin.mediaType)) fail("asset_pin_conflict", "icon", "Image pins conflict.");
          unique.set(pin.id, pin);
        }
        const pins = [...unique.values()];
        const nodeAssociations = node.authoredDetailAssets ?? [];
        if (!Array.isArray(pins) || !Array.isArray(nodeAssociations) || pins.length !== nodeAssociations.length) {
          fail("asset_inventory_mismatch", `turn[${turn.sequence - 1}].acceptedView`, "Node Detail visual asset inventory is inconsistent.");
        }
        for (const pin of pins) {
          const association = nodeAssociations.find((candidate) => candidate?.assetId === pin?.id);
          if (association) {
            requireString(association.assetId, "authoredDetailAssets.assetId");
            if (!/^[a-f0-9]{64}$/u.test(association.digestSha256 ?? "")) fail("asset_digest_invalid", "authoredDetailAssets.digestSha256", "Visual asset digest is invalid.");
            if (!SAFE_ASSET_MEDIA_TYPES.has(association.mediaType)) fail("asset_media_invalid", "authoredDetailAssets.mediaType", "Visual asset media type is unsupported.");
            requireInteger(association.byteLength, "authoredDetailAssets.byteLength", { minimum: 1 });
            const provenance = requireRecord(association.provenance, "authoredDetailAssets.provenance");
            requireString(provenance.source, "authoredDetailAssets.provenance.source");
            requireString(provenance.fileName, "authoredDetailAssets.provenance.fileName");
          }
          const content = association && contentByDigest.get(association.digestSha256);
          if (!association || !content
            || pin.digestSha256 !== association.digestSha256
            || pin.mediaType !== association.mediaType
            || association.mediaType !== content.mediaType
            || association.byteLength !== content.byteLength) {
            fail("asset_inventory_mismatch", `turn[${turn.sequence - 1}].acceptedView`, "Node Detail visual asset does not match published content.");
          }
          referencedDigests.add(association.digestSha256);
          associations.set(`${pin.id}\0${pin.digestSha256}\0${pin.mediaType}`, content);
        }
      }
    }
  }
  for (const input of boundInputs) {
    const pin = iconAssetPin(input.icon);
    if (!pin && !input.iconAsset) continue;
    const sourceAssociation = projections.flatMap(turn => turn.acceptedView?.layers ?? [])
      .flatMap(layer => layer.nodes).filter(node => node.id === input.sourceNodeId)
      .flatMap(node => node.authoredDetailAssets ?? []).find(association => association.assetId === pin?.id && association.digestSha256 === pin?.digestSha256 && association.mediaType === pin?.mediaType);
    verifyPin(pin, input.iconAsset ?? sourceAssociation);
  }
  for (const digest of contentByDigest.keys()) {
    if (!referencedDigests.has(digest)) fail("asset_content_unreferenced", "assets", "Visual asset content is not referenced by an accepted node.");
  }
  return associations;
}

function validateOrigin(origin, path, exportVersion = 4) {
  const value = requireRecord(origin, path);
  const kind = requireString(own(value, "kind", `${path}.kind`), `${path}.kind`);
  if (kind === "user") return { kind };
  if (kind === "invocation" && exportVersion === 4) {
    return { kind, invocationId: requirePortableId(own(value, "invocationId", `${path}.invocationId`), "invocation", `${path}.invocationId`) };
  }
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

function validateAction(action, path, { sourceLayerRequired = false, exportVersion = 4 } = {}) {
  const value = requireRecord(action, path);
  if (value.convertedFromInvoke !== undefined && typeof value.convertedFromInvoke !== "boolean") {
    fail("converted_invoke_shape", path, "Converted invoke provenance must be boolean.");
  }
  if (value.convertedFromInvoke === true && (value.kind !== "navigate" || value.relation !== "expand" || value.targetLayerId == null)) {
    fail("converted_invoke_shape", path, "Converted invokes must be accepted expand navigation with a target.");
  }
  if (own(value, "state", `${path}.state`) !== "accepted") {
    fail("action_state_invalid", `${path}.state`, "Public snapshots may contain accepted actions only.");
  }
  requirePortableId(own(value, "id", `${path}.id`), "action", `${path}.id`);
  requirePortableId(own(value, "sourceNodeId", `${path}.sourceNodeId`), "node", `${path}.sourceNodeId`);
  if (value.sourceLayerId != null) requirePortableId(value.sourceLayerId, "layer", `${path}.sourceLayerId`);
  if (sourceLayerRequired && value.sourceLayerId == null) {
    fail("action_source_layer_missing", `${path}.sourceLayerId`, "Resolved actions require source-layer provenance.");
  }
  const kind = requireString(own(value, "kind", `${path}.kind`), `${path}.kind`);
  if (!ACTION_KINDS.has(kind)) fail("action_kind_invalid", `${path}.kind`, "Unknown action kind.");
  if (value.reusable != null) {
    if (typeof value.reusable !== "boolean" || (kind !== "invoke" && value.convertedFromInvoke !== true)) {
      fail("invoke_reusable_invalid", path, "Only Invoke definitions or converted Invoke history carry boolean reuse policy.");
    }
    if (exportVersion < 4) fail("invoke_reuse_policy_version", path, "Explicit Invoke reuse policy requires V4.");
  }
  const label = requireString(own(value, "label", `${path}.label`), `${path}.label`);
  const variant = requireString(own(value, "variant", `${path}.variant`), `${path}.variant`);
  if (!ACTION_VARIANTS.has(variant)) fail("action_variant_invalid", `${path}.variant`, "Unknown action variant.");
  if (value.clientKey != null) requireString(value.clientKey, `${path}.clientKey`);
  if (value.icon != null) validatedIcon(value.icon, `${path}.icon`);
  if (value.description != null) requireString(value.description, `${path}.description`);
  if (kind === "navigate") {
    const relation = requireString(own(value, "relation", `${path}.relation`), `${path}.relation`);
    if (!NAVIGATION_RELATIONS.has(relation)) fail("navigate_relation_invalid", `${path}.relation`, "Unknown navigation relation.");
    requirePortableId(own(value, "targetLayerId", `${path}.targetLayerId`), "layer", `${path}.targetLayerId`);
    if (value.interactionText != null || value.input != null) fail("action_shape_invalid", path, "Navigate actions cannot carry invoke or input fields.");
  } else if (kind === "invoke") {
    requireString(own(value, "interactionText", `${path}.interactionText`), `${path}.interactionText`);
    if (value.relation != null || value.targetLayerId != null || value.input != null) fail("action_shape_invalid", path, "Invoke actions cannot carry navigation or input fields.");
    const bindings = requireArray(value.inputActionIds ?? [], `${path}.inputActionIds`);
    if (bindings.length > MAX_ACTIONS_PER_LAYER || new Set(bindings).size !== bindings.length) fail("invoke_binding_invalid", path, "Input bindings must be bounded and distinct.");
    bindings.forEach(id => requirePortableId(id, "action", `${path}.inputActionIds`));
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

function validateLayer(resolved, path, allDefinitions, exportVersion) {
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
    validatedIcon(own(item, "icon", `${nodePath}.icon`), `${nodePath}.icon`);
    for (const field of ["kind", "title", "detail"]) requireString(own(item, field, `${nodePath}.${field}`), `${nodePath}.${field}`, { allowEmpty: field === "detail" });
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
  if (layer.defaultNodeId != null) {
    requirePortableId(layer.defaultNodeId, "node", `${path}.layer.defaultNodeId`);
    if (!memberNodeSet.has(layer.defaultNodeId)) fail("default_node_outside_layer", `${path}.layer.defaultNodeId`, "The default node must belong to its layer.");
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
    const item = validateAction(action, actionPath, { sourceLayerRequired: !(exportVersion >= 3 && action.kind === "navigate"), exportVersion });
    if (seenActionIds.has(item.id)) fail("duplicate_action_id", actionPath, "An action appears more than once in one layer.");
    seenActionIds.add(item.id);
    if (!memberNodeSet.has(item.sourceNodeId)) fail("action_source_outside_layer", `${actionPath}.sourceNodeId`, "An action source must be a member of its layer.");
    // Completion-scoped node/layer keys can repeat in a V3 current closure.
    // Compiled controls still resolve one exact node plus action client key.
    if (exportVersion >= 3 && item.clientKey != null) {
      const key = JSON.stringify([item.sourceNodeId, item.clientKey]);
      const existing = allDefinitions.actionClientKeys.get(key);
      if (existing !== undefined && existing !== item.id) fail("duplicate_action_client_key", actionPath, "An action key must identify one action for its exact source node.");
      allDefinitions.actionClientKeys.set(key, item.id);
    }
    const previous = allDefinitions.actions.get(item.id);
    const fingerprint = stableJson(item);
    if (previous && previous !== fingerprint) fail("action_identity_conflict", `${actionPath}.id`, "A portable action ID has conflicting definitions.");
    allDefinitions.actions.set(item.id, fingerprint);
  });
  if (layer.layout != null) {
    const layout = requireRecord(layer.layout, `${path}.layer.layout`);
    if (layout.version !== 1) fail("unsupported_layout_version", `${path}.layer.layout.version`, "Only layout version 1 is supported.");
    // Absent on layers accepted before edge shapes; a shape this viewer does not know draws with the design default.
    if (layout.edgeShape != null && typeof layout.edgeShape !== "string") fail("layout_edge_shape_invalid", `${path}.layer.layout.edgeShape`, "An edge shape must be a string.");
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
    if (layout.edgeRoutes != null) {
      const routesPath = `${path}.layer.layout.edgeRoutes`;
      const routed = new Set();
      requireArray(layout.edgeRoutes, routesPath).forEach((route, index) => {
        const routePath = `${routesPath}[${index}]`;
        const item = requireRecord(route, routePath);
        const invalid = (field, message) => fail("layout_edge_route_invalid", `${routePath}${field}`, message);
        const edgeId = requirePortableId(own(item, "edgeId", `${routePath}.edgeId`), "edge", `${routePath}.edgeId`);
        const edge = edges.find((candidate) => candidate?.id === edgeId);
        if (!edge || routed.has(edgeId)) invalid(".edgeId", "A route must name a distinct edge in its layer.");
        routed.add(edgeId);
        // Shapes and sides a newer build knows draw with defaults here, so only their type is checked.
        if (item.shape != null && typeof item.shape !== "string") invalid(".shape", "An edge shape must be a string.");
        if (item.ends != null) {
          const ends = requireArray(item.ends, `${routePath}.ends`);
          const nodes = ends.map((end, endIndex) => {
            const endItem = requireRecord(end, `${routePath}.ends[${endIndex}]`);
            if (endItem.side != null && typeof endItem.side !== "string") invalid(`.ends[${endIndex}].side`, "A side must be a string.");
            return endItem.nodeId;
          });
          if (nodes.length !== 2 || [...nodes].sort().join("\u0000") !== [...edge.endpoints].sort().join("\u0000")) invalid(".ends", "A route's ends must be its edge's two nodes.");
        }
        if (item.waypoints != null) {
          const waypoints = requireArray(item.waypoints, `${routePath}.waypoints`);
          if (item.ends == null || waypoints.length > MAX_EDGE_ROUTE_WAYPOINTS) invalid(".waypoints", "Waypoints need both ends and number at most four.");
          waypoints.forEach((point, pointIndex) => {
            const pointItem = requireRecord(point, `${routePath}.waypoints[${pointIndex}]`);
            for (const coordinate of ["x", "y"]) {
              const value = pointItem[coordinate];
              if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail("layout_coordinate_invalid", `${routePath}.waypoints[${pointIndex}].${coordinate}`, "Layout coordinates must be finite numbers from zero through one.");
            }
          });
        }
      });
    }
  }
  return { layerId, value, actions };
}

function validateAcceptedView(view, path, exportVersion) {
  const value = requireRecord(view, path);
  const interactionNodeId = requirePortableId(own(value, "interactionNodeId", `${path}.interactionNodeId`), "node", `${path}.interactionNodeId`);
  const rootLayerId = requirePortableId(own(value, "rootLayerId", `${path}.rootLayerId`), "layer", `${path}.rootLayerId`);
  const rootAction = validateAction(own(value, "rootAction", `${path}.rootAction`), `${path}.rootAction`, { exportVersion });
  if (rootAction.convertedFromInvoke === true || rootAction.sourceNodeId !== interactionNodeId || rootAction.sourceLayerId != null || rootAction.kind !== "navigate" || rootAction.relation !== "expand" || rootAction.targetLayerId !== rootLayerId) {
    fail("invalid_root_action", `${path}.rootAction`, "The root action must be an expand from the interaction node to rootLayerId.");
  }
  const layers = requireArray(own(value, "layers", `${path}.layers`), `${path}.layers`);
  if (!layers.length || layers.length > MAX_LAYERS_PER_TURN) fail("layer_count_out_of_bounds", `${path}.layers`, "An accepted view must contain one to 10,000 layers.");
  const definitions = { nodes: new Map(), edges: new Map(), actions: new Map(), actionClientKeys: new Map() };
  const layerMap = new Map();
  const validated = layers.map((resolved, index) => validateLayer(resolved, `${path}.layers[${index}]`, definitions, exportVersion));
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
    const layerId = pending.pop();
    if (visited.has(layerId)) continue;
    visited.add(layerId);
    const resolved = layerMap.get(layerId);
    for (const action of resolved.actions) {
      if (action.id === rootAction.id) fail("root_action_repeated", `${path}.actions`, "The root action must not appear in a resolved layer.");
      // V3 includes accepted invocation results across completions; later
      // reference actions can revisit layers expanded by an earlier completion.
      if (exportVersion < 3 && targetRelations.has(action.targetLayerId) && targetRelations.get(action.targetLayerId) !== action.relation) {
        fail("mixed_target_relations", `${path}.actions`, "A layer cannot be targeted as both expand and reference.");
      }
      if (action.kind !== "navigate") continue;
      if (!layerMap.has(action.targetLayerId)) fail("navigate_target_unresolved", `${path}.actions`, `Navigate target ${action.targetLayerId} is absent.`);
      if (exportVersion < 3) targetRelations.set(action.targetLayerId, action.relation);
      pending.push(action.targetLayerId);
      if (action.relation === "expand") {
        const targets = expandEdges.get(layerId) ?? [];
        targets.push(action.targetLayerId);
        expandEdges.set(layerId, targets);
      }
    }
  }
  if (visited.size !== layerMap.size) fail("incomplete_navigation_closure", `${path}.layers`, "Every resolved layer must be reachable from the root.");
  const visiting = new Set();
  const checked = new Set();
  for (const start of layerMap.keys()) {
    const stack = [{ layerId: start, exit: false }];
    while (stack.length) {
      const { layerId, exit } = stack.pop();
      if (exit) {
        visiting.delete(layerId);
        checked.add(layerId);
        continue;
      }
      if (checked.has(layerId)) continue;
      if (visiting.has(layerId)) fail("expand_cycle", `${path}.layers`, "Expand navigation must be acyclic.");
      visiting.add(layerId);
      stack.push({ layerId, exit: true });
      for (const target of expandEdges.get(layerId) ?? []) stack.push({ layerId: target, exit: false });
    }
  }
  return value;
}

function normalizeLayer(resolved, layerKeys, invokeTargets) {
  const layer = cloneJson(resolved.layer);
  return {
    layer,
    nodes: cloneJson(resolved.nodes),
    edges: cloneJson(resolved.edges),
    actions: resolved.actions.map((action) => ({
      ...cloneJson(action),
      // Shared packages use export-local IDs as binding aliases. A reused
      // action may retain provenance from a layer outside the visible snapshot.
      // Derive only for the generated alias convention; never invent private keys.
      sourceLayerClientKey: layerKeys.get(action.sourceLayerId)
        ?? (action.clientKey === action.id ? action.sourceLayerId : undefined),
      ...(action.kind === "input" ? {
        control: action.input.control,
        prompt: action.input.prompt,
        options: cloneJson(action.input.options ?? []),
        minimumSelections: action.input.minimumSelections ?? null,
      } : {}),
      ...(action.kind === "invoke" && invokeTargets.has(action.id)
        ? { targetLayerId: invokeTargets.get(action.id) } : {}),
    })),
  };
}

function interactionFromTurn(turn, threadId, layers) {
  const view = turn.acceptedView;
  const rootLayer = layers.get(view.rootLayerId);
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
      rootLayer,
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

function exactFields(value, fields, path) {
  requireRecord(value, path);
  if (Object.keys(value).some(key => !fields.includes(key))) fail("invocation_shape_invalid", path, "Unknown Invocation field.");
  for (const field of fields) own(value, field, `${path}.${field}`);
}

function validateInvocations(header, turns) {
  const calls = requireArray(header.invocations ?? [], "header.invocations");
  if ((calls.length && header.exportVersion !== 4) || calls.length > MAX_TURNS) fail("invocation_inventory_version", "header.invocations", "Invocation inventory requires V4 and is bounded.");
  const ids = new Set(), children = new Set(), results = new Set();
  for (const [index, call] of calls.entries()) {
    const path = `header.invocations[${index}]`;
    exactFields(call, ["schemaVersion", "id", "source", "childInteractionNodeId", "resultTurnId", "lifecycle", "headRevision", "currentLayerId", "returnedLayerId", "arguments", "current", "safeReason"], path);
    requirePortableId(call.id, "invocation", `${path}.id`);
    requirePortableId(call.childInteractionNodeId, "node", `${path}.childInteractionNodeId`);
    const source = call.source;
    exactFields(source, ["interactionNodeId", "actionId", "parentNodeId", "layerId", "instruction", "label", "description", "icon", "iconAsset", "variant", "inputActionIds", "inputBindingsDefined", "parentTitle", "parentDetail", "state", ...(Object.hasOwn(source, "iconAssetOmitted") ? ["iconAssetOmitted"] : []), ...(Object.hasOwn(source, "reusable") ? ["reusable"] : [])], `${path}.source`);
    if (source.reusable != null && typeof source.reusable !== "boolean") fail("invoke_reusable_invalid", path, "Reuse is an explicit boolean Invoke policy.");
    for (const field of ["interactionNodeId", "parentNodeId"]) requirePortableId(source[field], "node", `${path}.source.${field}`);
    requirePortableId(source.actionId, "action", `${path}.source.actionId`);
    if (source.layerId != null) requirePortableId(source.layerId, "layer", `${path}.source.layerId`);
    for (const field of ["instruction", "label", "parentTitle", "parentDetail"]) requireString(source[field], `${path}.source.${field}`, { allowEmpty: field === "parentDetail" });
    if (source.description != null) requireString(source.description, `${path}.source.description`);
    if (source.icon != null) validatedIcon(source.icon, `${path}.source.icon`);
    if (source.iconAssetOmitted !== undefined && typeof source.iconAssetOmitted !== "boolean") fail("invocation_source_invalid", path, "Image omission must be explicit boolean provenance.");
    if (source.iconAssetOmitted && (!iconAssetPin(source.icon) || source.iconAsset != null)) fail("invocation_source_invalid", path, "Omitted historical bytes require an exact image pin and no replacement association.");
    if (!ACTION_VARIANTS.has(source.variant) || (source.variant === "card") !== (source.description != null)) fail("invocation_source_invalid", path, "Source action presentation is invalid.");
    if (call.schemaVersion !== 1 || ids.has(call.id) || children.has(call.childInteractionNodeId)
      || call.childInteractionNodeId === source.interactionNodeId || !["draft", "accepted", "stopped"].includes(source.state)
      || !["active", "succeeded", "stopped", "failed"].includes(call.lifecycle)) fail("invocation_identity_invalid", path, "Invalid or repeated Invocation identity.");
    ids.add(call.id); children.add(call.childInteractionNodeId);
    requireInteger(call.headRevision, `${path}.headRevision`);
    if (call.safeReason != null) requireString(call.safeReason, `${path}.safeReason`);
    const bindings = requireArray(source.inputActionIds, `${path}.source.inputActionIds`);
    if (typeof source.inputBindingsDefined !== "boolean" || (!source.inputBindingsDefined && bindings.length)) fail("invocation_binding_invalid", path, "Historical undeclared bindings must remain explicitly absent.");
    if (new Set(bindings).size !== bindings.length || bindings.length > MAX_ACTIONS_PER_LAYER) fail("invocation_binding_duplicate", path, "Invalid input binding inventory.");
    bindings.forEach(id => requirePortableId(id, "action", path));
    for (const field of ["currentLayerId", "returnedLayerId"]) if (call[field] != null) requirePortableId(call[field], "layer", `${path}.${field}`);
    if ((call.lifecycle === "succeeded") !== (call.returnedLayerId != null)
      || call.currentLayerId !== (call.current?.rootLayerId ?? null)
      || (call.returnedLayerId != null && call.returnedLayerId !== call.currentLayerId)) fail("invocation_current_returned_mismatch", path, "Current is not Return; only succeeded calls may have a Returned layer.");
    if (call.current != null) {
      exactFields(call.current, ["rootLayerId", "layers"], `${path}.current`);
      validateAcceptedView({ interactionNodeId: call.childInteractionNodeId, rootLayerId: call.current.rootLayerId, layers: call.current.layers,
        rootAction: { id: `action:validation-${index}`, sourceNodeId: call.childInteractionNodeId, kind: "navigate", relation: "expand", label: "Current", variant: "chip", targetLayerId: call.current.rootLayerId, state: "accepted" } }, `${path}.current`, 4);
    }
    const argumentsList = requireArray(call.arguments, `${path}.arguments`);
    if (argumentsList.length > MAX_ACTIONS_PER_LAYER) fail("invocation_arguments_invalid", path, "Arguments are bounded.");
    const occurrences = new Set();
    for (const argument of argumentsList) {
      exactFields(argument, ["source", "action", "value"], `${path}.arguments`);
      exactFields(argument.source, ["interactionNodeId", "layerId", "actionId", "nodeId"], `${path}.arguments.source`);
      for (const field of ["interactionNodeId", "nodeId"]) requirePortableId(argument.source[field], "node", path);
      requirePortableId(argument.source.layerId, "layer", path); requirePortableId(argument.source.actionId, "action", path);
      if (source.inputBindingsDefined && argument.source.nodeId !== source.parentNodeId) {
        fail("invocation_argument_source_mismatch", path, "Declared arguments must retain their exact source parent Node.");
      }
      const occurrence = stableJson({ interactionNodeId: argument.source.interactionNodeId, layerId: argument.source.layerId, actionId: argument.source.actionId });
      if (occurrences.has(occurrence)) fail("invocation_argument_duplicate", path, "Repeated argument occurrence.");
      occurrences.add(occurrence);
      const question = requireRecord(argument.action, path), value = requireRecord(argument.value, path);
      if (Object.keys(question).some(key => !["control", "prompt", "options", "minimumSelections"].includes(key))) fail("invocation_argument_value_invalid", path, "Unknown frozen question field.");
      requireString(question.prompt, path);
      if (question.control === "text") {
        if ((question.options?.length ?? 0) !== 0 || question.minimumSelections != null) fail("invocation_argument_value_invalid", path, "Text questions cannot declare selections.");
        exactFields(value, ["kind", "text"], path);
        if (value.kind !== "text") fail("invocation_argument_value_invalid", path, "Value control mismatch.");
        requireString(value.text, path);
      } else {
        if (!["single_select", "multi_select"].includes(question.control)) fail("invocation_argument_value_invalid", path, "Unknown control.");
        exactFields(value, ["kind", "selected"], path);
        if (value.kind !== "selected") fail("invocation_argument_value_invalid", path, "Value control mismatch.");
        const options = requireArray(question.options, path), selected = requireArray(value.selected, path);
        const optionKeys = options.map(option => { exactFields(option, ["key", "label"], path); requireString(option.key, path); requireString(option.label, path); return option.key; });
        if (question.minimumSelections != null) requireInteger(question.minimumSelections, path, { minimum: 1 });
        if (!options.length || options.length > 50 || (question.control === "single_select" && question.minimumSelections != null)
          || (question.minimumSelections ?? 1) > options.length || new Set(optionKeys).size !== options.length || !selected.length || new Set(selected.map(option => option.key)).size !== selected.length
          || (question.control === "single_select" && selected.length !== 1) || selected.length < (question.minimumSelections ?? 1)
          || selected.some(option => !options.some(accepted => stableJson(accepted) === stableJson(option)))) fail("invocation_argument_value_invalid", path, "Selections must exactly match frozen options.");
      }
    }
    const argumentIds = argumentsList.map(argument => argument.source.actionId);
    if (source.inputBindingsDefined && (new Set(argumentIds).size !== argumentIds.length
      || stableJson([...argumentIds].sort()) !== stableJson([...bindings].sort()))) fail("invocation_arguments_invalid", path, "Arguments must exactly match declared captured bindings without repeated answers.");
    if (call.resultTurnId != null) {
      requirePortableId(call.resultTurnId, "turn", `${path}.resultTurnId`);
      const turn = turns.find(candidate => candidate.id === call.resultTurnId);
      if (results.has(call.resultTurnId) || !turn || turn.origin.kind !== "invocation" || turn.origin.invocationId !== call.id
        || turn.interactionNodeId !== call.childInteractionNodeId
        || (turn.acceptedView && (call.lifecycle !== "succeeded" || turn.acceptedView.rootLayerId !== call.returnedLayerId))) fail("invocation_result_mismatch", path, "Result must retain its exact child, Invocation origin, and Returned layer.");
      results.add(call.resultTurnId);
    }
  }
  for (const turn of turns) if (turn.origin.kind === "invocation" && !calls.some(call => call.id === turn.origin.invocationId && call.resultTurnId === turn.id)) fail("invocation_origin_missing", "turn.origin", "Invocation origin requires its exact inventory call.");
  if (header.exportVersion === 4) {
    const records = { layers: new Map(), nodes: new Map(), edges: new Map(), actions: new Map() };
    const views = [...turns.map(turn => turn.acceptedView).filter(Boolean), ...calls.map(call => call.current).filter(Boolean)];
    for (const view of views) for (const layer of view.layers) {
      for (const [kind, entries] of [["layers", [layer.layer]], ["nodes", layer.nodes], ["edges", layer.edges], ["actions", layer.actions]]) for (const entry of entries) {
        const canonical = stableJson(entry), prior = records[kind].get(entry.id);
        if (prior != null && prior !== canonical) fail("invocation_record_conflict", "header.invocations.current", "Current and returned inventory must preserve immutable records.");
        records[kind].set(entry.id, canonical);
      }
    }
  }
  return calls;
}

function validateBoundInputs(header, turns, invocations) {
  const boundInputs = requireArray(header.boundInputs ?? [], "header.boundInputs");
  if ((boundInputs.length && header.exportVersion !== 4) || boundInputs.length > MAX_TURNS) fail("bound_input_inventory_version", "header.boundInputs", "Standalone input definitions require bounded export V4 inventory.");
  if (header.exportVersion !== 4) return boundInputs;
  const definitions = new Map();
  const register = (action) => {
    const prior = definitions.get(action.id);
    if (prior && stableJson(prior) !== stableJson(action)) fail("bound_input_definition_conflict", "header.boundInputs", "A canonical action cannot have conflicting definitions.");
    definitions.set(action.id, action);
  };
  const views = [...turns.map(turn => turn.acceptedView).filter(Boolean), ...invocations.map(call => call.current).filter(Boolean)];
  for (const view of views) for (const layer of view.layers) for (const action of layer.actions) register(action);
  const declared = new Set();
  for (const [index, value] of boundInputs.entries()) {
    const path = `header.boundInputs[${index}]`;
    const action = validateAction(value, path);
    if (action.kind !== "input" || declared.has(action.id)) fail("bound_input_definition_invalid", path, "Standalone definitions must be distinct accepted input actions.");
    declared.add(action.id);
    const question = action.input;
    if (!question || !["text", "single_select", "multi_select"].includes(question.control)) fail("bound_input_definition_invalid", path, "Unknown input control.");
    requireString(question.prompt, path);
    const options = requireArray(question.options ?? [], path);
    const keys = options.map(option => { exactFields(option, ["key", "label"], path); requireString(option.key, path); requireString(option.label, path); return option.key; });
    if (Object.keys(question).some(key => !["control", "prompt", "options", "minimumSelections"].includes(key))
      || options.length > 50 || new Set(keys).size !== keys.length
      || (question.control === "text" && (options.length || question.minimumSelections != null))
      || (question.control !== "text" && !options.length)
      || (question.control === "single_select" && question.minimumSelections != null)) fail("bound_input_definition_invalid", path, "Invalid frozen input definition.");
    if (question.minimumSelections != null) {
      requireInteger(question.minimumSelections, path, { minimum: 1 });
      if (question.minimumSelections > options.length) fail("bound_input_definition_invalid", path, "Selection cardinality exceeds the frozen options.");
    }
    register(action);
  }
  if (header.exportVersion === 4) for (const invoke of definitions.values()) {
    if (invoke.kind !== "invoke") continue;
    for (const id of invoke.inputActionIds ?? []) {
      const input = definitions.get(id);
      if (!input || input.kind !== "input" || input.sourceNodeId !== invoke.sourceNodeId) fail("bound_input_unresolved", "actions.inputActionIds", "An Invoke binding requires its exact same-Node canonical input definition.");
    }
  }
  return boundInputs;
}

function validateTurn(turn, path, manifestEntry, exportVersion) {
  const value = requireRecord(turn, path);
  if (value.recordType !== "turn") fail("record_type_invalid", `${path}.recordType`, "Every record after the header must be a turn.");
  const id = requirePortableId(own(value, "id", `${path}.id`), "turn", `${path}.id`);
  if (id !== manifestEntry.id) fail("turn_manifest_mismatch", `${path}.id`, "Turn ID does not match the header manifest.");
  const sequence = requireInteger(own(value, "sequence", `${path}.sequence`), `${path}.sequence`, { minimum: 1 });
  if (sequence !== manifestEntry.sequence) fail("turn_manifest_mismatch", `${path}.sequence`, "Turn sequence does not match the header manifest.");
  requireString(own(value, "createdAt", `${path}.createdAt`), `${path}.createdAt`);
  requireString(own(value, "text", `${path}.text`), `${path}.text`, { allowEmpty: true });
  if (value.interactionNodeId != null) requirePortableId(value.interactionNodeId, "node", `${path}.interactionNodeId`);
  validateOrigin(own(value, "origin", `${path}.origin`), `${path}.origin`, exportVersion);
  const status = validateCompletion(own(value, "completion", `${path}.completion`), `${path}.completion`);
  if (!Object.prototype.hasOwnProperty.call(value, "acceptedView")) fail("field_missing", `${path}.acceptedView`, "Every V1 turn must declare acceptedView.");
  if (status === "accepted" && !value.acceptedView) fail("accepted_view_missing", `${path}.acceptedView`, "An accepted turn must include its immutable accepted view.");
  if (status !== "accepted" && value.acceptedView != null) fail("accepted_view_unexpected", `${path}.acceptedView`, "Only accepted turns may include an accepted view.");
  if (value.contexts != null) {
    requireArray(value.contexts, `${path}.contexts`).forEach((context, index) => {
      const contextPath = `${path}.contexts[${index}]`;
      requireRecord(context, contextPath);
      requireRecord(context.source, `${contextPath}.source`);
      requireRecord(context.target, `${contextPath}.target`);
      if (context.target.icon != null) validatedIcon(context.target.icon, `${contextPath}.target.icon`);
      requirePortableId(context.id, "action", `${contextPath}.id`);
      requirePortableId(context.target.id, "node", `${contextPath}.target.id`);
      requirePortableId(context.source.interactionNodeId, "node", `${contextPath}.source.interactionNodeId`);
      requirePortableId(context.source.layerId, "layer", `${contextPath}.source.layerId`);
      if (context.source.ownerTurnId != null) {
        requirePortableId(context.source.ownerTurnId, "turn", `${contextPath}.source.ownerTurnId`);
        if (exportVersion < 3) fail("context_owner_invalid", contextPath, "Portable context ownership requires V3 or later.");
      }
    });
  }
  if (value.submittedInputs != null) requireArray(value.submittedInputs, `${path}.submittedInputs`);
  if (status === "accepted") {
    const view = validateAcceptedView(value.acceptedView, `${path}.acceptedView`, exportVersion);
    if (value.interactionNodeId != null && value.interactionNodeId !== view.interactionNodeId) {
      fail("interaction_node_mismatch", `${path}.interactionNodeId`, "Turn interactionNodeId must match acceptedView.interactionNodeId.");
    }
    value.interactionNodeId ??= view.interactionNodeId;
  }
  return value;
}

// Only portable, included provenance becomes navigator edges. Layer occurrence
// and chronological order never establish ownership.
function projectInteractionGraphs(interactions, turns, layersByTurn, exportVersion, invocations) {
  const byId = new Map(interactions.map(interaction => [interaction.id, interaction]));
  const owners = new Map();
  for (const turn of turns) {
    const sources = new Map();
    let complete = true;
    const group = (owner) => {
      if (!sources.has(owner.id)) sources.set(owner.id, {
        interactionId: owner.id, threadId: owner.threadId, graphNodeId: owner.graphNodeId,
        text: owner.text, completionStatus: owner.completionStatus, layers: [], invocationActionId: null,
      });
      return sources.get(owner.id);
    };
    for (const context of turn.contexts ?? []) {
      const ownerId = context.source.ownerTurnId;
      if (ownerId == null) { complete = false; continue; }
      const owner = byId.get(ownerId);
      const layer = layersByTurn.get(ownerId)?.get(context.source.layerId);
      if (exportVersion < 3 || !owner || owner.sequence >= turn.sequence
        || !layer?.nodes.some(node => node.id === context.target.id)
        || (owners.has(context.source.layerId) && owners.get(context.source.layerId) !== ownerId)) {
        fail("context_owner_invalid", `turn[${turn.sequence - 1}].contexts`, "Context ownership requires one earlier included accepted owner and its exact layer membership.");
      }
      owners.set(context.source.layerId, ownerId);
      const source = group(owner);
      let entry = source.layers.find(candidate => candidate.layerId === context.source.layerId);
      if (!entry) { entry = { layerId: context.source.layerId, nodeIds: [] }; source.layers.push(entry); }
      if (!entry.nodeIds.includes(context.target.id)) entry.nodeIds.push(context.target.id);
    }
    const origin = validateOrigin(turn.origin, `turn[${turn.sequence - 1}].origin`);
    if (origin.kind === "action") {
      const source = byId.get(origin.sourceTurnId);
      // Accepted origins were checked against exact source actions above.
      if (source) group(source).invocationActionId = origin.sourceActionId;
      else complete = false;
    } else if (origin.kind === "invocation") {
      const call = invocations.find(candidate => candidate.id === origin.invocationId);
      const source = interactions.find(candidate => candidate.graphNodeId === call?.source.interactionNodeId);
      if (source) group(source).invocationActionId = call.source.actionId;
      else complete = false;
    }
    if (byId.has(turn.id)) byId.get(turn.id).interactionGraph = { enabled: true, complete, sources: [...sources.values()] };
  }
}

export function publicState(snapshot) {
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
    actionInvocations: (snapshot.invocations ?? []).flatMap(call => {
      const source = acceptedInteractions.find(candidate => candidate.graphNodeId === call.source.interactionNodeId);
      const result = snapshot.turns.find(candidate => candidate.id === call.resultTurnId);
      return source && result ? [{ id: call.id, reusable: true, sourceInteractionId: source.id, actionId: call.source.actionId, resultInteractionId: result.id, resultCompletionStatus: result.completion.status }] : [];
    }),
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
 * Parse the Rust conversation-export V1 through V4 JSONL contract and return the safe
 * read model consumed by the public viewer. Non-accepted turns remain in
 * `turns` for diagnostics but are never placed in `interactions`.
 */
export function parseConversationExportSnapshot(input) {
  const records = parseJsonl(input);
  const header = records[0];
  const { conversation, manifest } = validateHeader(header);
  if (records.slice(1).some((record) => record?.recordType === "header")) {
    fail("header_repeated", "records", "A V1 snapshot may contain only one header.");
  }
  const contentRecords = [];
  let turnOffset = 1;
  if (header.exportVersion >= 2) {
    while (records[turnOffset]?.recordType === "visualAssetContent") {
      contentRecords.push(decodeAssetContent(records[turnOffset], `asset[${contentRecords.length}]`));
      turnOffset += 1;
    }
  }
  if (records.length - turnOffset !== manifest.length) {
    fail("turn_count_mismatch", "records", "Turn records must match the header manifest exactly.");
  }
  const turns = records.slice(turnOffset).map((turn, index) => validateTurn(turn, `turn[${index}]`, manifest[index], header.exportVersion));
  const invocations = validateInvocations(header, turns);
  const boundInputs = validateBoundInputs(header, turns, invocations);
  if (header.exportVersion < 3 && turns.some(turn => turn.acceptedView && [turn.acceptedView.rootAction, ...turn.acceptedView.layers.flatMap(layer => layer.actions)].some(action => action.convertedFromInvoke === true))) {
    fail("converted_invoke_version", "turns", "Converted invoke provenance requires export V3.");
  }
  const contentByDigest = new Map();
  for (const content of contentRecords) {
    if (contentByDigest.has(content.digestSha256)) fail("asset_digest_duplicate", "assets", "Visual asset digest appears more than once.");
    contentByDigest.set(content.digestSha256, content);
  }
  const assetAssociations = validateAssetAssociations(turns, contentByDigest, invocations, boundInputs);
  const threadId = `export:${conversation.id}`;
  const acceptedTurns = turns.filter((turn) => turn.completion.status === "accepted");
  if (!acceptedTurns.length) fail("accepted_turn_required", "turns", "A public snapshot must contain at least one accepted turn.");
  const acceptedById = new Map(acceptedTurns.map((turn) => [turn.id, turn]));
  const layerKeys = new Map(acceptedTurns.flatMap((turn) => turn.acceptedView.layers.map(({ layer }) => [
    layer.id, layer.clientKey,
  ])));
  // Check both declared origins and included converted destinations. Reused source
  // nodes may present the same action in several turns; do not infer its owner from
  // the first occurrence or require an external result turn to be included.
  const convertedTargets = new Map();
  for (const turn of turns) {
    const origin = validateOrigin(turn.origin, `turn[${turn.sequence - 1}].origin`);
    const source = origin.kind === "action" ? acceptedById.get(origin.sourceTurnId) : null;
    const action = source?.acceptedView.layers.flatMap(layer => layer.actions).find(candidate => candidate.id === origin.sourceActionId);
    const priorConverted = convertedTargets.get(turn.acceptedView?.rootLayerId);
    if (priorConverted && (origin.kind !== "action" || !priorConverted.has(origin.sourceActionId)
      || source?.sequence >= turn.sequence || action?.convertedFromInvoke !== true
      || action.targetLayerId !== turn.acceptedView.rootLayerId)) {
      fail("invoke_origin_invalid", `turn[${turn.sequence - 1}].origin`, "Included converted results must retain their source action origin.");
    }
    if (action?.convertedFromInvoke === true && (source.sequence >= turn.sequence || turn.completion.status !== "accepted" || action.targetLayerId !== turn.acceptedView?.rootLayerId)) {
      fail("invoke_origin_invalid", `turn[${turn.sequence - 1}].origin`, "Converted invoke origins require their exact accepted destination.");
    }
    for (const candidate of turn.acceptedView?.layers.flatMap(layer => layer.actions) ?? []) {
      if (candidate.convertedFromInvoke !== true) continue;
      if (!convertedTargets.has(candidate.targetLayerId)) convertedTargets.set(candidate.targetLayerId, new Set());
      convertedTargets.get(candidate.targetLayerId).add(candidate.id);
    }
  }
  // A converted action may be presented after its included result. Validate the
  // complete inventory for both uniqueness and the declared action identity.
  for (const turn of acceptedTurns) {
    const actions = convertedTargets.get(turn.acceptedView.rootLayerId);
    if (!actions) continue;
    const origin = validateOrigin(turn.origin, `turn[${turn.sequence - 1}].origin`);
    if (actions.size !== 1 || origin.kind !== "action" || !actions.has(origin.sourceActionId)) {
      fail("invoke_origin_invalid", `turn[${turn.sequence - 1}].origin`, "An included converted result requires one unambiguous source action origin.");
    }
  }
  const invokeTargets = new Map();
  const invokeDestinationTurns = new Map();
  for (const turn of acceptedTurns) {
    const origin = validateOrigin(turn.origin, `turn[${turn.sequence - 1}].origin`);
    if (origin.kind !== "action") continue;
    const source = acceptedById.get(origin.sourceTurnId);
    const action = source?.acceptedView.layers.flatMap((layer) => layer.actions)
      .find((candidate) => candidate.id === origin.sourceActionId);
    if (!source || source.sequence >= turn.sequence || (action?.kind !== "invoke" && action?.convertedFromInvoke !== true)
      || (action?.convertedFromInvoke === true && action.targetLayerId !== turn.acceptedView.rootLayerId)
      || invokeTargets.has(action.id)) {
      fail("invoke_origin_invalid", `turn[${turn.sequence - 1}].origin`, "Accepted invoke results require one earlier accepted source action.");
    }
    invokeTargets.set(action.id, turn.acceptedView.rootLayerId);
    invokeDestinationTurns.set(action.id, turn.id);
  }
  const layersByTurn = new Map(acceptedTurns.map((turn) => [turn.id, new Map(
    turn.acceptedView.layers.map((resolved) => [
      resolved.layer.id, normalizeLayer(resolved, layerKeys, invokeTargets),
    ]),
  )]));
  const interactions = acceptedTurns.map((turn) => interactionFromTurn(turn, threadId, layersByTurn.get(turn.id)));
  for (const interaction of interactions) {
    const call = invocations.find(candidate => candidate.resultTurnId === interaction.id);
    if (call) interaction.submittedInputs = cloneJson(call.arguments);
  }
  projectInteractionGraphs(interactions, turns, layersByTurn, header.exportVersion, invocations);
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
    invocations: cloneJson(invocations),
    boundInputs: cloneJson(boundInputs),
    assetContents: contentRecords.map(cloneJson),
    state: null,
    layerFor(turnId, layerId) {
      return layersByTurn.get(String(turnId))?.get(String(layerId)) ?? null;
    },
    invokeDestinationTurnId(actionId) {
      return invokeDestinationTurns.get(actionId) ?? null;
    },
    invocationResultTurnId(invocationId) {
      const call = invocations.find(candidate => candidate.id === invocationId);
      return call?.lifecycle === "succeeded" ? call.resultTurnId : null;
    },
    invocationCurrentLayer(invocationId, layerId) {
      const call = invocations.find(candidate => candidate.id === invocationId);
      const layer = call?.current?.layers.find(candidate => candidate.layer.id === layerId);
      return layer ? normalizeLayer(layer, layerKeys, new Map()) : null;
    },
    boundInputsForInvoke(action) {
      const definitions = [...boundInputs, ...acceptedTurns.flatMap(turn => turn.acceptedView.layers.flatMap(layer => layer.actions)), ...invocations.flatMap(call => call.current?.layers.flatMap(layer => layer.actions) ?? [])];
      return (action?.inputActionIds ?? []).map(id => cloneJson(definitions.find(input => input.id === id && input.kind === "input" && input.sourceNodeId === action.sourceNodeId)));
    },
    turnContainingLayer(layerId) {
      return interactions.find((interaction) => layersByTurn.get(String(interaction.id))?.has(String(layerId))) ?? null;
    },
    async resolveNodeDetailAsset(asset, dependencies = {}) {
      const content = assetAssociations.get(`${asset?.id}\0${asset?.digestSha256}\0${asset?.mediaType}`);
      if (!content) throw new Error("Visual asset is not pinned by this public snapshot.");
      const decoded = atob(content.contentBase64);
      const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
      const crypto = dependencies.crypto ?? globalThis.crypto;
      const digest = await crypto?.subtle?.digest("SHA-256", bytes);
      if (!digest) throw new Error("Visual asset digest verification is unavailable.");
      const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (hex !== content.digestSha256) throw new Error("Visual asset digest mismatch.");
      const URLApi = dependencies.URL ?? globalThis.URL;
      const BlobType = dependencies.Blob ?? globalThis.Blob;
      const url = URLApi.createObjectURL(new BlobType([bytes], { type: content.mediaType }));
      let released = false;
      return Object.freeze({
        url,
        digestSha256: hex,
        mediaType: content.mediaType,
        release() {
          if (!released) URLApi.revokeObjectURL(url);
          released = true;
        },
      });
    },
  };
  snapshot.state = publicState(snapshot);
  return Object.freeze(snapshot);
}

// Kept as an import-compatible name for existing ordinary-export callers.
export const parseConversationExportV1 = parseConversationExportSnapshot;
export const parsePublicSnapshot = parseConversationExportSnapshot;

export const publicSnapshotLimits = Object.freeze({
  maxExportBytes: MAX_EXPORT_BYTES,
  maxJsonlLineBytes: MAX_JSONL_LINE_BYTES,
  maxTurns: MAX_TURNS,
  maxLayersPerTurn: MAX_LAYERS_PER_TURN,
});

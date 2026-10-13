import { isProxy } from "node:util/types";
import { randomUUID } from "node:crypto";
import { isImageIcon } from "./image-icons.js";
import { LayerObject, layerId, nodeId, type ActionObject, type NodeReference } from "./objects.js";

type Payload = Record<string, unknown>;
export interface ActionRecipe {
  readonly object: ActionObject;
  readonly payload: Payload;
  readonly inputs: readonly (number | ActionRecipe)[];
}

function data(value: unknown): Payload {
  if (typeof value !== "object" || value === null || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Action declarations must be ordinary own data properties");
  const result: Payload = Object.create(null) as Payload;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable) throw new Error("Action declarations must be ordinary own data properties");
    result[key] = descriptor.value;
  }
  return result;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error("Input references must be an ordinary dense array");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw new Error("Input references must be an ordinary dense array");
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw new Error("Input references must be own data properties");
    return descriptor.value;
  });
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Input action ID must be a positive safe integer");
  return value;
}

/** Capture the entire write recipe before transport, including all dependencies. */
export function snapshotActionRecipe(source: NodeReference, action: ActionObject): ActionRecipe {
  const sourceNodeId = nodeId(source);
  const keys = new Set<string>();
  const identities = new Set<object>();
  const ids = new Set<number>();
  function capture(object: ActionObject, dependency = false): ActionRecipe {
    const fields = data(object);
    if (dependency && fields.kind !== "input") throw new Error("Invoke references must name Input declarations");
    if (!["input", "invoke", "navigate"].includes(String(fields.kind))) throw new Error("Unknown action kind");
    if (typeof fields.label !== "string" || !fields.label.trim()) throw new Error("Action label is required");
    const clientKey = fields.clientKey ?? randomUUID();
    if (typeof clientKey !== "string" || !clientKey.trim() || clientKey !== clientKey.trim() || clientKey.includes("\0") || Buffer.byteLength(clientKey) > 128) throw new Error("Action clientKey must be a stable identity");
    if (keys.has(clientKey) || identities.has(object)) throw new Error("Duplicate Input declaration");
    keys.add(clientKey); identities.add(object);
    if (fields.clientKey === undefined) object.clientKey = clientKey;
    const sourceLayer = fields.sourceLayer as ActionObject["sourceLayer"];
    if (dependency && sourceLayer instanceof LayerObject && !sourceLayer.nodes.some((node) => node === source || nodeId(node) === sourceNodeId)) throw new Error("Input declaration belongs to another source Node");
    if (sourceLayer === undefined && fields.kind !== "navigate") throw new Error("Input and Invoke require a source Layer");
    const variant = fields.variant ?? "pill";
    if (!["chip", "pill", "wide", "card"].includes(String(variant)) || (fields.description != null && typeof fields.description !== "string")) throw new Error("Invalid action presentation");
    const icon = fields.icon == null ? null : typeof fields.icon === "string" ? fields.icon : data(fields.icon);
    if (icon !== null && typeof icon !== "string" && !isImageIcon(icon)) throw new Error("Invalid action icon");
    const payload: Payload = { clientKey, sourceNodeId, sourceLayerId: sourceLayer === undefined ? null : layerId(sourceLayer), kind: fields.kind, label: fields.label,
      variant, icon, description: fields.description ?? null };
    if (fields.kind === "input") {
      if (!["text", "single_select", "multi_select"].includes(String(fields.control)) || typeof fields.prompt !== "string" || !fields.prompt.trim()) throw new Error("Input control and prompt are required");
      Object.assign(payload, { control: fields.control, prompt: fields.prompt });
      if (fields.control !== "text") payload.options = array(fields.options).map((option) => {
        const entry = data(option);
        if (typeof entry.key !== "string" || typeof entry.label !== "string") throw new Error("Invalid Input option");
        return { key: entry.key, label: entry.label };
      });
      else if (fields.options !== undefined || fields.minimumSelections !== undefined) throw new Error("Text Inputs cannot declare selection options");
      if (fields.minimumSelections !== undefined) {
        if (!Number.isSafeInteger(fields.minimumSelections) || (fields.minimumSelections as number) < 0) throw new Error("Invalid minimum selections");
        payload.minimumSelections = fields.minimumSelections;
      }
    } else if (fields.kind === "navigate") {
      Object.assign(payload, { relation: fields.relation, targetLayerId: layerId(fields.target as Parameters<typeof layerId>[0]) });
    } else {
      if (typeof fields.interactionText !== "string" || !fields.interactionText.trim() || (fields.reusable !== undefined && typeof fields.reusable !== "boolean")) throw new Error("Invalid Invoke declaration");
      Object.assign(payload, { interactionText: fields.interactionText, reusable: fields.reusable ?? false });
    }
    const inputs = fields.kind === "invoke" ? array(fields.inputActions ?? []).map((input): number | ActionRecipe => {
      const entry = typeof input === "number" ? undefined : data(input);
      if (entry && !Object.hasOwn(entry, "id")) return capture(input as ActionObject, true);
      if (entry && entry.kind !== "input") throw new Error("Invoke references must name Input actions");
      const id = positiveId(entry ? entry.id : input);
      if (ids.has(id)) throw new Error("Duplicate Input action ID");
      ids.add(id); return id;
    }) : [];
    return { object, payload, inputs };
  }
  return capture(action);
}

import { createHash } from "node:crypto";
import type { InteractionInput } from "@relayer/graph-client";

/** Match graph core's recursively sorted object keys, preserving array order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("CompletionContract contains an invalid JSON value");
  return encoded;
}

/** Normalized inputs have semantic ordering; contract answers have occurrence ordering. */
function semanticInputBag(values: readonly unknown[]): string {
  return JSON.stringify(values.map(canonicalJson).sort());
}

/** Refuse incompatible or corrupted preparation before any inference begins. */
export function validateCompletionContract(input: InteractionInput, interactionNodeId: number): void {
  const contract = input.completionContract;
  if (contract === undefined) {
    if (input.completionContractStatus === "sealed") throw new Error("Sealed interaction is missing its CompletionContract");
    // Pre-contract server preparations have no marker. Graph core checks durable
    // sealing provenance; transport compatibility cannot mint new authority.
    return;
  }
  if (input.completionContractStatus === "legacy") throw new Error("Legacy interaction cannot carry a CompletionContract");
  if (contract.schemaVersion !== 1) throw new Error("Unsupported CompletionContract schema version");
  if (contract.interactionNodeId !== interactionNodeId || input.interaction.id !== interactionNodeId) {
    throw new Error("CompletionContract does not match the interaction node");
  }
  const { digest, ...sealed } = contract;
  const expected = `sha256:v1:${createHash("sha256").update(canonicalJson(sealed)).digest("hex")}`;
  if (digest !== expected) throw new Error("CompletionContract digest mismatch");
  if (contract.input.text !== input.interaction.detail
    || canonicalJson(contract.input.context) !== canonicalJson(input.contexts.map(({ targetNode, annotations }) => ({ nodeId: targetNode.id, annotations })))
    || semanticInputBag(contract.input.answers.map(({ question, value }) => ({ action: question, value }))) !== semanticInputBag(input.submittedInputs ?? [])) {
    throw new Error("CompletionContract input does not match normalized interaction input");
  }
}

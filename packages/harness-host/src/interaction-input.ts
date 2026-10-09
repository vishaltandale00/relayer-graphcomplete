import type { InteractionInput } from "@relayer/graph-client";
import type { HarnessRunContext } from "./types.js";

/** Serialize only the normalized interaction input shared by every harness. */
export function renderInteractionInput(input: InteractionInput): string {
  return JSON.stringify({
    ...(input.interactionPermissions ? { interactionPermissions: input.interactionPermissions } : {}),
    message: input.interaction.detail,
    contexts: input.contexts.map(({ targetNode, annotations }) => ({
      targetNode: {
        id: targetNode.id,
        kind: targetNode.kind,
        icon: targetNode.icon,
        title: targetNode.title,
        detail: targetNode.detail,
        state: targetNode.state,
      },
      annotations,
    })),
    ...(input.submittedInputs?.length ? { submittedInputs: input.submittedInputs } : {}),
  }, null, 2);
}

export const INTERACTION_INPUT_GUIDANCE = `The message, every attached node annotation, and every submitted input snapshot are one interaction input. Preserve context target and annotation order. Submitted inputs are an unordered collection of prompt/control/value snapshots; the product assigns no semantic precedence or independent work. Use your own judgment to infer their meaning. The graph capability can re-read this exact normalized input from the interaction pointer, including in native child agents. The read-only interactionPermissions snapshot describes this interaction's frozen policy; it cannot be edited or supplied as new authority. Enabled version 2 requires a new usable navigate control from each distinct navigate.add node to this interaction's response root before terminal acceptance. Version 1, absent snapshots, and disabled snapshots impose no such obligation. Do not try to create, modify, or delete interaction context or submitted input. An annotation on an artifact node is the user's note from the artifact viewer: it says where they were and may name a screenshot file of what they saw; open that image before acting on the note.`;

/**
 * A fresh root run has no native memory of its thread. It receives the thread's accepted
 * interactions in order and reads anything else through the graph. Empty for every other run.
 */
export function renderThreadHistory(context: HarnessRunContext | undefined, language: "javascript" | "python"): string {
  if (context?.nativeSession !== "fresh") return "";
  const readLayer = language === "javascript" ? "await graph.getLayer(responseLayerId)" : "await graph.get_layer(response_layer_id)";
  return `
This run starts a fresh session. It has no memory of earlier turns in this thread; the thread's accepted interactions, oldest first, are:
${JSON.stringify(context.threadHistory ?? [], null, 2)}
Read an earlier answer with ${readLayer}, or search the thread. Other runs in this thread can be working at the same time. Their work becomes readable once they advance or return it.
`;
}

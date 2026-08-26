import type { InteractionInput } from "@relayer/graph-client";

/** Serialize only the normalized interaction input shared by every harness. */
export function renderInteractionInput(input: InteractionInput): string {
  return JSON.stringify({
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
  }, null, 2);
}

export const INTERACTION_INPUT_GUIDANCE = `The message and every attached node annotation are one interaction input. Preserve target and annotation order, and use your own judgment to infer their meaning; the product assigns no semantic precedence. The graph capability can re-read this exact normalized input from the interaction pointer, including in native child agents. Do not try to create, modify, or delete interaction context.`;

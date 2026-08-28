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
    ...(input.submittedInputs?.length ? { submittedInputs: input.submittedInputs } : {}),
  }, null, 2);
}

export const INTERACTION_INPUT_GUIDANCE = `The message, every attached node annotation, and every submitted input snapshot are one interaction input. Preserve context target and annotation order. Submitted inputs are an unordered collection of prompt/control/value snapshots and do not assign priority or independent work. Use your own judgment to infer their meaning. The graph capability can re-read this exact normalized input from the interaction pointer, including in native child agents. Do not try to create, modify, or delete interaction context or submitted input.`;

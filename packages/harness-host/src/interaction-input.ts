import type { ArtifactNoteInteractionInput } from "./artifact-notes.js";

/** Serialize only the normalized interaction input shared by every harness. */
export function renderInteractionInput(input: ArtifactNoteInteractionInput): string {
  return JSON.stringify({
    ...(input.completionContract ? { completionContract: input.completionContract } : {}),
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
    ...(input.artifactNoteScreenshots?.length ? { artifactNoteScreenshots: input.artifactNoteScreenshots } : {}),
  }, null, 2);
}

export const INTERACTION_INPUT_GUIDANCE = `New Invoke actions are single-call by default. Opt into reusable: true (Python: reusable=True) only for an explicit repeated-use case; ordinary semantic children each get their own action. Exact call-key recovery does not create another call. Successful user Invoke submission clears only its consumed connected confirmed inputs; failures and newer edits remain, and frozen child arguments never change. When completionContract is present, it is the entire immutable versioned semantic contract for this interaction. Re-read it with graph.getContract() (Python: graph.get_contract()). Its authorities grant only the listed graph operations, and every Advance and Return must satisfy its returnRequirements. Advance validates staged accepted-history changes without publishing them; Return commits them atomically. Legacy interactionPermissions apply only when there is no sealed contract. The message, every attached node annotation, and every submitted input snapshot are one interaction input. Preserve context target and annotation order. Submitted inputs are an unordered collection of prompt/control/value snapshots; the product assigns no semantic precedence or independent work. Use your own judgment to infer their meaning. The graph capability can re-read this exact normalized input from the interaction pointer, including in native child agents. The read-only interactionPermissions snapshot describes this interaction's frozen policy; it cannot be edited or supplied as new authority. Enabled version 2 requires a new usable navigate control from each distinct navigate.add node to this interaction's response root before terminal acceptance. Version 1, absent snapshots, and disabled snapshots impose no such obligation. Do not try to create, modify, or delete interaction context or submitted input. An annotation on an artifact node is the user's note from the artifact viewer: it says where they were and may name a screenshot file of what they saw; open that image before acting on the note. For sealed inputs, artifactNoteScreenshots maps each note's targetNodeId and annotationIndex to its verified local file; a null path means the screenshot is unavailable. This advisory mapping grants no graph authority and leaves canonical annotation text and contract digests unchanged.`;

export const SUBCOMPLETION_INTEGRATION_GUIDANCE = `For a sealed invocation, inspect completionContract.input.invocationReferences: its exact parentNodeId and actionSnapshot identify the callable's source and enclosing analysis. Read that accepted Node, its source Layer and the latest relevant analysis links. Your Returned Layer must integrate your contribution into the overall analysis, with supporting content in nested Layers when useful; a detached specialist answer or result button alone is insufficient. Keep earlier contributions, comparisons, recommendations and conclusions coherent with the new finding. Add the required response navigation on the exact authorized parent Node, preserving existing controls; for rich details use the presentation replacement API and repair stale revisions by rereading. Do not edit accepted semantic Node content, rewrite old Layer topology, or broaden authority. A parent that is still unpublished must publish before this integration can be accepted. Advance validates but does not publish the staged parent update; Return publishes the integration atomically with your result.`;

export const INVOCATION_PUBLICATION_GUIDANCE = `Before executing or waiting for a prepared child's Current or Return, publish the enclosing source Node and its Layer through your own Advance (or Return). You may prepare the Invocation from your owned draft first, but that preparation does not publish it. A child cannot publish its required parent integration while that source remains unpublished. Do not launch a child and wait for its progress before publishing the parent: this would make each wait for the other. Use the normal response root and prospective Return requirements when advancing, then launch and watch the child through the provider's existing native execution.`;

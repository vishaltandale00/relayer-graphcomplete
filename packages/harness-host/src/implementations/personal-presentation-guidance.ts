import type { ResolvedPersonalPresentation } from "@relayer/graph-client";
import type { HarnessRunContext } from "../types.js";

export function renderPersonalPresentationGuidance(
  presentation: ResolvedPersonalPresentation,
): string {
  if (presentation.attachment.versionInteractionNodeId !== presentation.graph.nodeId) {
    throw new Error("Personal presentation attachment does not match the resolved version interaction");
  }
  if (presentation.attachment.rootLayerId !== presentation.graph.rootLayerId) {
    throw new Error("Personal presentation attachment does not match the resolved root layer");
  }
  const seenLayers = new Set<number>();
  const seenNodes = new Set<number>();
  const preferences: string[] = [];
  for (const resolved of presentation.graph.layers) {
    if (resolved.layer.state !== "accepted" || !seenLayers.add(resolved.layer.id)) {
      throw new Error("Personal presentation contains a duplicate or non-accepted layer");
    }
    if (resolved.layer.nodes.length !== resolved.nodes.length
      || resolved.layer.nodes.some((id, index) => id !== resolved.nodes[index]?.id)) {
      throw new Error("Personal presentation layer membership is not canonical");
    }
    for (const node of resolved.nodes) {
      if (node.state !== "accepted" || !seenNodes.add(node.id)) {
        throw new Error("Personal presentation contains a duplicate or non-accepted node");
      }
      if (node.kind !== "presentation-preference") continue;
      if (node.title.trim() === "" || node.detail.trim() === "") {
        throw new Error("Personal presentation preference title and detail are required");
      }
      preferences.push(`${node.title}: ${node.detail}`);
    }
  }
  return preferences.length === 0
    ? ""
    : `Personal graph presentation preferences:\n\n${preferences.join("\n\n")}`;
}

export function personalPresentationPrompt(context: HarnessRunContext): string {
  if (context.personalPresentation === undefined) return "";
  const rendered = renderPersonalPresentationGuidance(context.personalPresentation);
  if (rendered === "") return "";
  return `\n\n${rendered}\n\n${personalPresentationAuthority}`;
}

export function personalPresentationNativeInstructions(context: HarnessRunContext): string {
  if (context.personalPresentation === undefined) return "";
  const rendered = renderPersonalPresentationGuidance(context.personalPresentation);
  if (rendered === "") return "";
  return `If you are the root agent, include the exact rendered Personal graph presentation preferences block from the current root task only when assigning a native child to author graph content. Never include that block in an unrelated delegate's task. If you are a native child, apply personal presentation preferences only when that exact rendered block is present in your assigned task; otherwise do not infer, retrieve, or apply them. ${personalPresentationAuthority}`;
}

const personalPresentationAuthority = "Graph integrity and authority remain mandatory. An explicit user presentation request takes precedence over these attached preferences, and these preferences take precedence over provider or model defaults. Apply the same pinned preferences to the root agent and every native child that can author graph content for this interaction. Do not pass them to unrelated delegated agents.";

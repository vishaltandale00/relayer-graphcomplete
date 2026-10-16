import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { CompletionOutput } from "@relayer/graph-client";

type Node = DefaultTreeAdapterTypes.Node;

function children(node: Node): readonly Node[] {
  return "childNodes" in node ? node.childNodes : [];
}

function excluded(node: Node): boolean {
  return "tagName" in node && (["script", "style", "template", "noscript"].includes(node.tagName)
    || node.attrs.some(({ name, value }) => name === "hidden" || name === "inert"
      || (name === "aria-hidden" && value.toLowerCase() === "true")));
}

function text(node: Node): string {
  if (excluded(node)) return "";
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if ("tagName" in node && node.tagName === "br") return " ";
  return children(node).map(text).join("");
}

// Marker exclusion applies to all authored channels, independently of whether
// their content is a visible semantic heading. parse5 decodes text and attributes.
function machineMarker(fragment: Node): boolean {
  const pending: Node[] = [fragment];
  let decodedText = "";
  while (pending.length) {
    const node = pending.pop()!;
    if ("value" in node) decodedText += node.value;
    if ("data" in node && node.data.includes("GRAPH_MEMORY_ANCHOR:")) return true;
    if ("attrs" in node && node.attrs.some(attr => attr.value.includes("GRAPH_MEMORY_ANCHOR:"))) return true;
    pending.push(...[...children(node)].reverse());
    if ("tagName" in node && node.tagName === "template" && "content" in node) pending.push(node.content);
  }
  return decodedText.includes("GRAPH_MEMORY_ANCHOR:");
}

/** Static semantic headings from accepted HTML; CSS visibility still needs rendered review. */
export function graphMemorySections(output: CompletionOutput, title: string) {
  let count = 0;
  let hasMachineMarker = false;
  const nodeTitles: string[] = [];
  for (const node of output.rootLayer.nodes) {
    let headings = 0;
    hasMachineMarker ||= JSON.stringify(node.authoredDetail ?? {}).includes("GRAPH_MEMORY_ANCHOR:");
    for (const component of node.authoredDetail?.components ?? []) {
      const fragment = parseFragment(component.html);
      hasMachineMarker ||= machineMarker(fragment);
      const pending: Node[] = [fragment];
      while (pending.length) {
        const element = pending.pop()!;
        if (excluded(element)) continue;
        if ("tagName" in element && /^h[1-6]$/.test(element.tagName)
          && text(element).replace(/\s+/gu, " ").trim() === title) headings += 1;
        pending.push(...children(element));
      }
    }
    hasMachineMarker ||= node.title.includes("GRAPH_MEMORY_ANCHOR:") || node.detail.includes("GRAPH_MEMORY_ANCHOR:");
    // A Node title repeated by its own single HTML heading is one semantic target.
    const sections = Math.max(node.title === title ? 1 : 0, headings);
    count += sections;
    if (sections === 1) nodeTitles.push(node.title);
  }
  return { count, hasMachineMarker, nodeTitles };
}

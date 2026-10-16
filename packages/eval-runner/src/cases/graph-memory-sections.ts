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

/** Static semantic headings from accepted HTML; CSS visibility still needs rendered review. */
export function graphMemorySections(output: CompletionOutput, title: string) {
  let count = 0;
  let hasMachineMarker = false;
  const nodeTitles: string[] = [];
  for (const node of output.rootLayer.nodes) {
    let headings = 0;
    for (const component of node.authoredDetail?.components ?? []) {
      const fragment = parseFragment(component.html);
      hasMachineMarker ||= text(fragment).includes("GRAPH_MEMORY_ANCHOR:");
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

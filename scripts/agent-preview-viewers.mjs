/**
 * How each harness's candidate trace shows that its model received a draft
 * preview image (PRD §11.10, PREV-005). Each returns the preview files, with
 * when the trace observed them.
 */
import { basename } from "node:path";

/** Codex's native image viewer. */
export function codexImageViews(events) {
  return events
    .filter((event) => event.type === "provider.event" && event.data?.method === "item/completed"
      && event.data.params?.item?.type === "imageView")
    .map((event) => ({ observedAt: event.observedAt, file: basename(String(event.data.params.item.path ?? "")) }));
}

/** Claude's code-owned view_graph_preview tool; its trace holds metadata only. */
export function claudePreviewViews(events) {
  return events
    .filter((event) => event.type === "tool.call.completed" && event.data?.tool === "view_graph_preview"
      && event.data.outcome === "viewed")
    .map((event) => ({ observedAt: event.observedAt, file: String(event.data.file ?? "") }));
}

/** Prime's native attach_image skill: an image block in a successful ipython result. */
export function primeImageAttachments(events) {
  return events
    .filter((event) => event.type === "tool.call.completed" && event.data?.isError !== true
      && event.data?.result?.content?.some((block) => block?.type === "image"))
    .flatMap((event) => (event.data.result.details?.attachments ?? [])
      .map((attachment) => ({ observedAt: event.observedAt, file: basename(String(attachment?.path ?? "")) })));
}

export const PREVIEW_VIEWERS = Object.freeze({
  "codex-basic": codexImageViews,
  "claude-basic": claudePreviewViews,
  "prime-agent-basic": primeImageAttachments,
});

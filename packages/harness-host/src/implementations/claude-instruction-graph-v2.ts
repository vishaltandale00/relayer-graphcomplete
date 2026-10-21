import { createHash } from "node:crypto";
import { instructionGraphV2Corpus } from "./instruction-graph-v2.js";

let corpus: ReturnType<typeof instructionGraphV2Corpus> | undefined;

/** The shared JavaScript graph API is provider independent; Claude owns its preview tool. */
export function claudeInstructionGraphV2Corpus() {
  if (corpus) return corpus;
  const modules = Object.freeze(instructionGraphV2Corpus().modules.map(module => Object.freeze({
    key: module.key,
    title: module.title,
    detail: module.key === "preview"
      ? `When previews are enabled, a successful graph.submitNode or submitLayer may include preview:{status,path,width,height}. Status can be rendered, cached, failed or limit_reached. Print preview.path, then call the scoped Claude tool mcp__relayer_graph_preview__view_graph_preview with {path:preview.path} to see the PNG before final Return/submission. This tool reads only PNGs in this run's preview folder; do not substitute browser navigation or claim that Bash output displays the image. Inspect readable text, useful relationships, spacing, contrast and complete controls. If a preview reveals a defect in an unaccepted draft, repair with the same stable keys. If Current already accepted that phase, use a new coherent draft for changed content. A failed or capped preview is advisory and does not block task work. Do not claim visual verification without actually seeing an available image.`
      : module.detail,
    prerequisites: Object.freeze([...module.prerequisites]),
  })));
  for (const module of modules) {
    if (Buffer.byteLength(module.detail, "utf8") > 2400) throw new Error(`Claude instruction chunk exceeds 2400 UTF-8 bytes: ${module.key}`);
  }
  corpus = Object.freeze({ versionKey: "claude-instruction-graph-v2", retrievalContractVersion: 2,
    digest: createHash("sha256").update(JSON.stringify(modules)).digest("hex"), modules });
  return corpus;
}

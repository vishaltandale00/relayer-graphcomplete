import { codexInstructionGraphCorpus } from "./implementations/codex-basic.js";
import { claudeInstructionGraphV2Corpus } from "./implementations/claude-instruction-graph-v2.js";
import { primeInstructionGraphV2Corpus } from "./implementations/prime-instruction-graph-v2.js";

/** Trusted publication lookup. Task content cannot register instruction corpora. */
export function instructionGraphCorpus(versionKey: string) {
  switch (versionKey) {
    case "codex-instruction-graph-v1":
    case "codex-instruction-graph-v2":
      return codexInstructionGraphCorpus(versionKey);
    case "claude-instruction-graph-v2":
      return claudeInstructionGraphV2Corpus();
    case "prime-agent-instruction-graph-v2":
      return primeInstructionGraphV2Corpus();
    default:
      throw new Error(`Unknown code-owned instruction corpus: ${versionKey}`);
  }
}

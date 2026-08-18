import type { CompleteOptions, CompletionResult, InputGraph } from "./contracts.js";

export async function complete(inputGraph: InputGraph, options: CompleteOptions): Promise<CompletionResult> {
  if (inputGraph.version !== 1) {
    throw new Error(`Unsupported graph version: ${String(inputGraph.version)}`);
  }

  if (!inputGraph.nodes.some((node) => node.id === inputGraph.rootNodeId)) {
    throw new Error(`Graph root node does not exist: ${inputGraph.rootNodeId}`);
  }

  return options.runtime.run({ inputGraph, policy: options.policy, ...(options.signal === undefined ? {} : { signal: options.signal }) });
}

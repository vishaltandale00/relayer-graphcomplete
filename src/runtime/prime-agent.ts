import type { CompletionRequest, CompletionResult, GraphCompleteRuntime } from "../contracts.js";

export interface PrimeAgentRuntimeOptions {
  readonly cwd: string;
  readonly sessionDirectory?: string;
}

/**
 * Prime Agent execution boundary.
 *
 * The first implementation must use Prime Agent's native sessions, nested RLM
 * children, messaging, persistence, and model routing. Graph acceptance remains
 * this package's terminal condition; a root agent ending its turn is not enough.
 */
export class PrimeAgentRuntime implements GraphCompleteRuntime {
  public constructor(private readonly options: PrimeAgentRuntimeOptions) {}

  public async run(_request: CompletionRequest): Promise<CompletionResult> {
    throw new Error(`PrimeAgentRuntime is not implemented for ${this.options.cwd}`);
  }
}


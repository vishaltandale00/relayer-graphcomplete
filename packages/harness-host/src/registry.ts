import { CODEX_BASIC_KEY, createCodexBasicFactory } from "./implementations/codex-basic.js";
import { CLAUDE_BASIC_KEY, createClaudeBasicFactory } from "./implementations/claude-basic.js";
import { PRIME_AGENT_KEY, createPrimeAgentFactory } from "./implementations/prime-agent.js";
import type { HarnessFactory, HarnessImplementationMap } from "./types.js";

export function productHarnessImplementations(additional: Readonly<Record<string, HarnessFactory>> = {}): HarnessImplementationMap {
  return Object.freeze({
    [CODEX_BASIC_KEY]: createCodexBasicFactory(),
    [CLAUDE_BASIC_KEY]: createClaudeBasicFactory(),
    [PRIME_AGENT_KEY]: createPrimeAgentFactory(),
    ...additional,
  });
}

export function resolveHarnessFactory(implementations: HarnessImplementationMap, key: string): HarnessFactory {
  const factory = implementations[key];
  if (factory === undefined) throw new Error(`Harness implementation cannot be resolved: ${key}`);
  return factory;
}

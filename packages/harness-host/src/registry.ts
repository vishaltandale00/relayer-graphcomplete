import { CODEX_BASIC_KEY, createCodexBasicFactory } from "./implementations/codex-basic.js";
import type { HarnessFactory, HarnessMap } from "./types.js";

export function productHarnessMap(additional: Readonly<Record<string, HarnessFactory>> = {}): HarnessMap {
  return Object.freeze({ [CODEX_BASIC_KEY]: createCodexBasicFactory(), ...additional });
}

export function resolveHarnessFactory(harnesses: HarnessMap, key: string): HarnessFactory {
  const factory = harnesses[key];
  if (factory === undefined) throw new Error(`Harness implementation cannot be resolved: ${key}`);
  return factory;
}

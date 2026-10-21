import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { primeInstructionGraphV2Corpus } from "../src/implementations/prime-instruction-graph-v2.js";

it("publishes the exact independently bounded Python corpus consumed by recipe proof", async () => {
  const corpus = primeInstructionGraphV2Corpus();
  const fixture = JSON.parse(await readFile(new URL("../../../fixtures/prime-instruction-graph-v2.json", import.meta.url), "utf8"));
  expect(corpus).toEqual(fixture);
  expect(corpus.digest).toBe(createHash("sha256").update(JSON.stringify(corpus.modules)).digest("hex"));
  expect(new Set(corpus.modules.map(module => module.key)).size).toBe(corpus.modules.length);
  for (const module of corpus.modules) {
    expect(Buffer.byteLength(module.detail, "utf8"), module.key).toBeLessThanOrEqual(2400);
    for (const prerequisite of module.prerequisites) expect(corpus.modules.some(candidate => candidate.key === prerequisite)).toBe(true);
    expect(module.detail).not.toContain("GRAPH_CLIENT_MODULE_URL");
    expect(module.detail).not.toContain("RelayerGraphClient.fromEnv");
  }
});

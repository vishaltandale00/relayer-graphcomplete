import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RELAYER_ICON_NAMES as clientIconNames } from "../packages/graph-client/src/icons.js";
import { RELAYER_ICON_NAMES as rendererIconNames } from "../desktop/renderer/src/product-workspace/icons.js";

const repositoryFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const quotedNames = (block) => [...block.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);

function rustIconNames() {
  const source = repositoryFile("crates/relayer-graph-core/src/graph/model/icon.rs");
  return quotedNames(source.match(/RELAYER_ICON_NAMES:[\s\S]*?= &\[([\s\S]*?)\n\];/)?.[1] ?? "");
}

function pythonIconNames() {
  const source = repositoryFile("python/relayer-graph/src/relayer_graph/icons.py");
  return quotedNames(source.match(/RELAYER_ICON_NAMES = \(([\s\S]*?)\n\)/)?.[1] ?? "");
}

describe("cross-language Relayer icon vocabulary", () => {
  it("keeps every authoring and rendering boundary on the same curated list", () => {
    expect(rustIconNames()).toEqual([...clientIconNames]);
    expect(pythonIconNames()).toEqual([...clientIconNames]);
    expect(rendererIconNames).toEqual(clientIconNames);
  });
});

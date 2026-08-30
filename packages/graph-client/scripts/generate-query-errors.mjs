import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const contractPath = path.join(repositoryRoot, "docs/graph-query-v1-errors.json");
const rustContractPath = path.join(repositoryRoot, "crates/relayer-graph-core/src/query/error.rs");
const typescriptPath = path.join(packageRoot, "src/query-errors.generated.ts");
const pythonPath = path.join(repositoryRoot, "python/relayer-graph/src/relayer_graph/query_errors_generated.py");
const check = process.argv.includes("--check");

const contract = JSON.parse(await readFile(contractPath, "utf8"));
if (contract.queryContractVersion !== 1 || !Array.isArray(contract.errors)) {
  throw new Error("graph query error artifact must describe contract version 1");
}
const entries = contract.errors.map((entry) => {
  if (typeof entry?.code !== "string" || typeof entry?.phase !== "string") {
    throw new Error("every graph query error needs string code and phase fields");
  }
  return [entry.code, entry.phase];
});
if (new Set(entries.map(([code]) => code)).size !== entries.length) {
  throw new Error("graph query error codes must be unique");
}

const rustSource = await readFile(rustContractPath, "utf8");
const enumBody = rustSource.match(/pub enum QueryCode \{([\s\S]*?)\n\}/)?.[1];
const queryCodeImpl = rustSource.split("impl QueryCode {")[1];
const asStringBody = queryCodeImpl?.match(/pub fn as_str\(self\)[\s\S]*?match self \{([\s\S]*?)\n        \}/)?.[1];
const phaseBody = queryCodeImpl?.match(/pub fn phase\(self\)[\s\S]*?match self \{([\s\S]*?)\n        \}/)?.[1];
if (enumBody === undefined || asStringBody === undefined || phaseBody === undefined) {
  throw new Error("could not derive the Rust QueryCode contract");
}
const variants = [...enumBody.matchAll(/^    ([A-Z][A-Za-z0-9]+),$/gm)].map((match) => match[1]);
const codesByVariant = new Map(
  [...asStringBody.matchAll(/Self::([A-Za-z0-9]+) => "([a-z0-9_]+)"/g)]
    .map((match) => [match[1], match[2]]),
);
const phasesByVariant = new Map();
for (const match of phaseBody.matchAll(/((?:Self::[A-Za-z0-9]+\s*(?:\|\s*)?)+)=>\s*\{?\s*QueryPhase::([A-Za-z0-9]+)/g)) {
  for (const variant of match[1].matchAll(/Self::([A-Za-z0-9]+)/g)) {
    phasesByVariant.set(variant[1], match[2].toLowerCase());
  }
}
const rustEntries = variants.map((variant) => [codesByVariant.get(variant), phasesByVariant.get(variant)]);
if (rustEntries.some(([code, phase]) => code === undefined || phase === undefined)
    || JSON.stringify(rustEntries) !== JSON.stringify(entries)) {
  throw new Error("graph query error artifact has drifted from Rust QueryCode code/phase authority");
}

const typescript = `// Generated from docs/graph-query-v1-errors.json. Do not edit.\n` +
  `export const GRAPH_QUERY_ERROR_PHASES = {\n${entries.map(([code, phase]) => `  ${JSON.stringify(code)}: ${JSON.stringify(phase)},`).join("\n")}\n} as const;\n\n` +
  `export type GeneratedGraphQueryCode = keyof typeof GRAPH_QUERY_ERROR_PHASES;\n` +
  `export type GeneratedGraphQueryPhase = typeof GRAPH_QUERY_ERROR_PHASES[GeneratedGraphQueryCode];\n`;
const python = `# Generated from docs/graph-query-v1-errors.json. Do not edit.\n` +
  `from typing import Final\n\n` +
  `GRAPH_QUERY_ERROR_PHASES: Final = {\n${entries.map(([code, phase]) => `    ${JSON.stringify(code)}: ${JSON.stringify(phase)},`).join("\n")}\n}\n`;

for (const [target, expected] of [[typescriptPath, typescript], [pythonPath, python]]) {
  if (check) {
    const actual = await readFile(target, "utf8").catch(() => "");
    if (actual !== expected) throw new Error(`${path.relative(repositoryRoot, target)} is stale; run generate-query-errors.mjs`);
  } else {
    await writeFile(target, expected);
  }
}

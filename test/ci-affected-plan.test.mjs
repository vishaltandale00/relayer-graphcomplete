import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { selectCiMode } from "../scripts/ci/select-mode.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const plannerPath = join(repositoryRoot, "scripts", "ci", "plan-affected.mjs");
const configPath = join(repositoryRoot, "scripts", "ci", "affected-modules.v1.json");

function plan(...changedFiles) {
  const args = [plannerPath, "--repository", repositoryRoot];
  for (const changedFile of changedFiles) {
    args.push("--changed-file", changedFile);
  }
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
}

function fullPlanWithoutDiff() {
  return JSON.parse(
    execFileSync(process.execPath, [plannerPath, "--repository", repositoryRoot, "--mode", "full"], {
      encoding: "utf8",
    }),
  );
}

describe("affected-module plan v1", () => {
  test("is a checked-in versioned contract", () => {
    expect(JSON.parse(readFileSync(configPath, "utf8")).version).toBe(1);
  });

  test("full integration mode does not depend on a diff base", () => {
    const result = fullPlanWithoutDiff();

    expect(result.mode).toBe("full");
    expect(Object.values(result.chapters).every(Boolean)).toBe(true);
    expect(result.vitestFiles).toEqual([]);
  });

  test.each([
    [{ eventName: "push", headRef: "" }, "full"],
    [{ eventName: "push", headRef: "integration/cache-baseline" }, "full"],
    [{ eventName: "pull_request", headRef: "integration/issue-360" }, "full"],
    [{ eventName: "pull_request", headRef: "component/graph-core" }, "affected"],
  ])("routes GitHub event %j to %s mode", (event, expected) => {
    expect(selectCiMode(event)).toBe(expected);
  });

  test("derives the Rust reverse-dependency closure from Cargo metadata", () => {
    const result = plan("crates/relayer-graph-core/src/graph.rs");

    expect(result.mode).toBe("affected");
    expect(result.rustPackages).toEqual([
      "relayer-app-server",
      "relayer-graph-core",
      "relayer-graph-server",
    ]);
    expect(result.chapters.rust).toBe(true);
    expect(result.chapters.vitest).toBe(true);
    expect(result.npmBuildWorkspaces).toEqual(
      expect.arrayContaining(["@relayer/eval-runner", "@relayer/graph-client", "@relayer/harness-host"]),
    );
    expect(result.vitestFiles).toEqual(expect.arrayContaining(["packages", "test"]));
    expect(result.chapters.packaging).toBe(false);
  });

  test("derives npm reverse dependents and desktop seams from package dependencies", () => {
    const result = plan("packages/graph-client/src/index.ts");

    expect(result.mode).toBe("affected");
    expect(result.npmWorkspaces).toEqual([
      "@relayer/eval-runner",
      "@relayer/graph-client",
      "@relayer/harness-host",
      "relayer-desktop",
    ]);
    expect(result.npmBuildWorkspaces).toEqual([
      "@relayer/eval-runner",
      "@relayer/graph-client",
      "@relayer/harness-host",
      "relayer-desktop",
    ]);
    expect(result.chapters.typescript).toBe(true);
    expect(result.chapters.vitest).toBe(true);
    expect(result.vitestFiles).toEqual(expect.arrayContaining(["packages", "test"]));
    expect(result.chapters.packaging).toBe(false);
  });

  test("includes unchanged npm dependencies needed by a clean selected build", () => {
    const result = plan("packages/harness-host/src/host.ts");

    expect(result.npmWorkspaces).toEqual(["@relayer/eval-runner", "@relayer/harness-host", "relayer-desktop"]);
    expect(result.npmBuildWorkspaces).toContain("@relayer/graph-client");
  });

  test("selects packaging only for owned desktop packaging inputs", () => {
    const result = plan("desktop/main/index.mjs");

    expect(result.mode).toBe("affected");
    expect(result.npmWorkspaces).toEqual(["relayer-desktop"]);
    expect(result.chapters.packaging).toBe(true);
    expect(result.chapters.rust).toBe(false);
    expect(result.vitestFiles).toEqual(expect.arrayContaining(["packages", "test"]));
    expect(result.vitestRustPackages).toEqual(["relayer-app-server", "relayer-graph-server"]);
  });

  test("builds server binaries required by mapped Vitest integration tests", () => {
    const result = plan("desktop/renderer/src/product-workspace/workspace.js");

    expect(result.vitestFiles).toContain("test/first-message-composer-integration.test.mjs");
    expect(result.vitestRustPackages).toEqual(["relayer-app-server", "relayer-graph-server"]);
  });

  test.each([
    ["test/conversation-export-eval-e2e.test.mjs", ["relayer-app-server", "relayer-graph-server"]],
    ["test/eval-app-integration.test.mjs", ["relayer-app-server", "relayer-graph-server"]],
    ["test/eval-managed-codex-runtime.test.mjs", ["relayer-app-server", "relayer-graph-server"]],
    ["test/first-message-composer-integration.test.mjs", ["relayer-app-server", "relayer-graph-server"]],
    ["test/graph-authoring-replay.test.mjs", ["relayer-graph-server"]],
    ["test/graph-search-client-parity-e2e.test.mjs", ["relayer-graph-server"]],
    ["test/provider-straightforward-flow.test.mjs", ["relayer-app-server", "relayer-graph-server"]],
    ["test/recursive-complete-e2e.test.mjs", ["relayer-app-server", "relayer-graph-server"]],
  ])("builds the production Rust runtime required by %s", (changedFile, expectedPackages) => {
    expect(plan(changedFile).vitestRustPackages).toEqual(expectedPackages);
  });

  test("keeps cross-cutting source and authority seams on the complete fresh Vitest portfolio", () => {
    for (const changedFile of ["src/index.ts", "permissions/default.json", "harnesses/codex.json", "vendor/runtime.js"]) {
      expect(plan(changedFile).vitestFiles).toEqual(expect.arrayContaining(["packages", "test"]));
    }
  });

  test.each([
    ["python/relayer-graph/src/relayer_graph/client.py", "python"],
    ["docs/prd/index.html", "prd"],
    ["test/complete.test.ts", "vitest"],
  ])("maps %s to its owning %s chapter", (changedFile, chapter) => {
    const result = plan(changedFile);

    expect(result.mode).toBe("affected");
    expect(result.chapters[chapter]).toBe(true);
    if (changedFile.startsWith("test/")) expect(result.vitestFiles).toContain(changedFile);
  });

  test("routes PRD changes through readability and product-boundary checks", () => {
    const result = plan("docs/prd/index.html");

    expect(result.chapters.prd).toBe(true);
    expect(result.chapters.vitest).toBe(true);
    expect(result.vitestFiles).toContain("test/documentation-product-boundary.test.mjs");
  });

  test("routes bundled Python source through unit, integrity, and packaging gates", () => {
    const result = plan("python/relayer-graph/src/relayer_graph/client.py");

    expect(result.chapters.python).toBe(true);
    expect(result.chapters.vitest).toBe(true);
    expect(result.chapters.packaging).toBe(true);
    expect(result.vitestFiles).toEqual(
      expect.arrayContaining(["test/icon-vocabulary-parity.test.mjs", "test/prime-agent-packaging.test.mjs"]),
    );
  });

  test("keeps root TypeScript tests in the semantic typecheck", () => {
    expect(plan("test/complete.test.ts").rootTypeScript).toBe(true);
  });

  test("fails open when a deleted test would otherwise be the only Vitest filter", () => {
    const result = plan("test/retired-ci-test.test.mjs");

    expect(result.mode).toBe("full");
    expect(result.reasons.join(" ")).toContain("deleted test path");
  });

  test.each([
    "Cargo.lock",
    "package-lock.json",
    ".github/workflows/ci.yml",
    "docs/evidence/issue-257-browser-harnesses/manifest.json",
    "fixtures/graph-query-v1/positive.json",
    "unmapped/new-seam.txt",
  ])(
    "fails open to the full portfolio for %s",
    (changedFile) => {
      const result = plan(changedFile);

      expect(result.mode).toBe("full");
      expect(Object.values(result.chapters).every(Boolean)).toBe(true);
      expect(result.reasons.join(" ")).toContain(changedFile);
    },
  );
});

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
  });

  test("keeps cross-cutting source and authority seams on the complete fresh Vitest portfolio", () => {
    for (const changedFile of ["src/index.ts", "permissions/default.json", "harnesses/codex.json", "vendor/runtime.js"]) {
      expect(plan(changedFile).vitestFiles).toEqual(expect.arrayContaining(["packages", "test"]));
    }
  });

  test.each([
    ["python/relayer-graph/src/relayer_graph/client.py", "python"],
    ["docs/prd/index.html", "prd"],
    ["docs/evidence/issue-261-ladybug-probe/src/main.rs", "receipts"],
    ["test/complete.test.ts", "vitest"],
  ])("maps %s to its owning %s chapter", (changedFile, chapter) => {
    const result = plan(changedFile);

    expect(result.mode).toBe("affected");
    expect(result.chapters[chapter]).toBe(true);
    if (changedFile.startsWith("test/")) expect(result.vitestFiles).toContain(changedFile);
  });

  test.each(["Cargo.lock", "package-lock.json", ".github/workflows/ci.yml", "unmapped/new-seam.txt"])(
    "fails open to the full portfolio for %s",
    (changedFile) => {
      const result = plan(changedFile);

      expect(result.mode).toBe("full");
      expect(Object.values(result.chapters).every(Boolean)).toBe(true);
      expect(result.reasons.join(" ")).toContain(changedFile);
    },
  );
});

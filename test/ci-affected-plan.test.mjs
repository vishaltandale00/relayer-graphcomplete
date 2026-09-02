import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { selectCiMode } from "../scripts/ci/select-mode.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const plannerPath = join(repositoryRoot, "scripts", "ci", "plan-affected.mjs");
const configPath = join(
  repositoryRoot,
  "scripts",
  "ci",
  "affected-modules.v1.json",
);

function plan(...changedFiles) {
  const args = [plannerPath, "--repository", repositoryRoot];
  for (const changedFile of changedFiles) {
    args.push("--changed-file", changedFile);
  }
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
}

function fullPlanWithoutDiff() {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [plannerPath, "--repository", repositoryRoot, "--mode", "full"],
      {
        encoding: "utf8",
      },
    ),
  );
}

// Asserts a data-driven plan-resolution contract row. Every expectation is
// labeled with the row so a failing mapping names its own behavior.
function checkPlanRow(label, result, expected) {
  const scope = `${label} (${expected.changedFile})`;
  expect.soft(result.mode, `${scope}: mode`).toBe(expected.mode ?? "affected");
  if (expected.chaptersAllFalse) {
    expect.soft(
      Object.values(result.chapters).some(Boolean),
      `${scope}: no chapter may be selected`,
    ).toBe(false);
  }
  for (const [chapter, selected] of Object.entries(expected.chapters ?? {})) {
    expect.soft(result.chapters[chapter], `${scope}: chapter ${chapter}`).toBe(selected);
  }
  if (expected.vitestFilesExact) {
    expect.soft(result.vitestFiles, `${scope}: vitestFiles`).toEqual(expected.vitestFilesExact);
  }
  for (const file of expected.vitestFilesIncludes ?? []) {
    expect.soft(result.vitestFiles, `${scope}: vitestFiles must include ${file}`).toEqual(
      expect.arrayContaining([file]),
    );
  }
  for (const packageName of expected.rustPackagesIncludes ?? []) {
    expect.soft(result.rustPackages, `${scope}: rustPackages must include ${packageName}`).toEqual(
      expect.arrayContaining([packageName]),
    );
  }
  for (const workspace of expected.npmWorkspacesIncludes ?? []) {
    expect.soft(result.npmWorkspaces, `${scope}: npmWorkspaces must include ${workspace}`).toEqual(
      expect.arrayContaining([workspace]),
    );
  }
  if (expected.npmBuildWorkspacesIncludes) {
    expect.soft(result.npmBuildWorkspaces, `${scope}: npmBuildWorkspaces`).toEqual(
      expect.arrayContaining(expected.npmBuildWorkspacesIncludes),
    );
  }
  if (expected.rustCrash !== undefined) {
    expect.soft(result.rustCrash, `${scope}: rustCrash`).toBe(expected.rustCrash);
  }
  if (expected.rootTypeScript !== undefined) {
    expect.soft(result.rootTypeScript, `${scope}: rootTypeScript`).toBe(expected.rootTypeScript);
  }
}

// Each case spawns the planner as a subprocess, and the full-plan cases also
// run cargo metadata; the default 5s per-test budget races CI runner load.
describe("affected-module plan v1", { timeout: 30_000 }, () => {
  test("is a checked-in versioned contract whose crash lane never outruns the Rust chapter", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.version, "the affected-module map stays on version 1").toBe(1);
    expect(config.rustCrashPackages, "only graph crates own the crash lane").toEqual([
      "relayer-graph-core",
      "relayer-graph-server",
    ]);

    // The lbug-prebuilt job runs when rust, rust_runtime, or rust_crash is
    // set; the crash lane depends on it. If rustCrash could ever be true
    // while chapters.rust is false, the crash boundary lane would vanish
    // from CI with nothing red, so the implication is pinned for every Rust
    // owner prefix.
    for (const owner of config.rustOwners) {
      if (!owner.prefix) continue;
      const result = plan(`${owner.prefix}src/lib.rs`);
      if (result.rustCrash) {
        expect(result.chapters.rust, `${owner.prefix}: crash selection requires the Rust chapter`).toBe(true);
      }
    }
  });

  test("routes integration events to full mode and plans the full portfolio without a diff base", () => {
    const modeCases = [
      [{ eventName: "push", headRef: "" }, "full"],
      [{ eventName: "push", headRef: "integration/cache-baseline" }, "full"],
      [{ eventName: "pull_request", headRef: "integration/issue-360" }, "full"],
      [
        { eventName: "pull_request", headRef: "component/graph-core" },
        "affected",
      ],
    ];
    expect(modeCases).toHaveLength(4);
    for (const [event, expected] of modeCases) {
      expect.soft(
        selectCiMode(event),
        `${event.eventName} with head ref "${event.headRef}"`,
      ).toBe(expected);
    }

    const result = fullPlanWithoutDiff();
    expect(result.mode, "full mode does not depend on a diff base").toBe("full");
    expect(
      Object.values(result.chapters).every(Boolean),
      "full mode selects every chapter",
    ).toBe(true);
    expect(result.vitestFiles, "full mode runs the whole portfolio unfiltered").toEqual([]);
    expect(result.rustCrash, "full mode keeps crash reconciliation fresh").toBe(true);
    expect(result.runtimeRustPackages, "full mode builds both runtime servers").toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);
  });

  test("derives Rust closure, crash selection, and Clippy surface from Cargo metadata", () => {
    // Checkpoint 1: a graph-core change pulls the full reverse dependency
    // closure and the Vitest portfolio that exercises it.
    const closure = plan("crates/relayer-graph-core/src/graph.rs");
    expect(closure.mode, "graph-core maps precisely").toBe("affected");
    expect(closure.rustPackages, "the reverse closure carries every dependent crate").toEqual([
      "relayer-app-server",
      "relayer-graph-core",
      "relayer-graph-server",
      "relayer-telemetry-capability",
    ]);
    expect(closure.chapters.rust, "the Rust chapter is selected").toBe(true);
    expect(closure.rustCrash, "graph-core owns the crash lane").toBe(true);
    expect(closure.runtimeRustPackages, "runtime builds cover both servers").toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);
    expect(closure.chapters.vitest, "the fresh Vitest portfolio joins the closure").toBe(true);
    expect(closure.npmBuildWorkspaces, "Vitest prerequisite workspaces join the build").toEqual(
      expect.arrayContaining([
        "@relayer/eval-runner",
        "@relayer/graph-client",
        "@relayer/harness-host",
      ]),
    );
    expect(closure.vitestFiles, "the whole source portfolio runs fresh").toEqual(
      expect.arrayContaining(["packages", "test"]),
    );
    expect(closure.chapters.packaging, "packaging stays unselected for crate changes").toBe(false);

    // Checkpoint 2: crash reconciliation stays fresh for every graph crate
    // and for crates that flow into them through the dependency closure.
    for (const [label, changedFile] of [
      ["graph-server changes", "crates/relayer-graph-server/src/main.rs"],
      // Telemetry changes flow into graph-server through the dependency
      // closure, so the crash portfolio stays fresh for them too.
      ["telemetry-capability changes via the closure", "crates/relayer-telemetry-capability/src/lib.rs"],
    ]) {
      expect(plan(changedFile).rustCrash, `${label} keep the crash lane fresh`).toBe(true);
    }

    // Checkpoint 3: app-server-only changes skip the crash lane. The crash
    // command compiles and runs no app-server code; app-server
    // interrupted-execution recovery stays owned by its ordinary tests.
    // Build dependencies join rustPackages for Clippy, but crash selection
    // keys on the reverse closure, so they do not trigger the crash lane.
    const appServer = plan("crates/relayer-app-server/src/main.rs");
    expect(appServer.mode, "app-server maps precisely").toBe("affected");
    expect(appServer.rustPackages, "app-server stays in the Rust lane").toEqual(
      expect.arrayContaining(["relayer-app-server"]),
    );
    expect(appServer.chapters.rust, "the Rust chapter runs for app-server").toBe(true);
    expect(appServer.rustCrash, "app-server-only changes skip the crash lane").toBe(false);

    // Checkpoint 4: Clippy lints local dependencies through a changed package.
    expect(
      plan("crates/relayer-app-server/src/api.rs").rustPackages,
      "Clippy surface includes the local dependency closure",
    ).toEqual([
      "relayer-app-server",
      "relayer-graph-core",
      "relayer-graph-server",
      "relayer-telemetry-capability",
    ]);

    // Checkpoint 5: the frozen query specification joins the graph-core
    // closure, crash lane included.
    const querySpec = plan("docs/graph-query-v1.md");
    expect(querySpec.mode, "the query specification maps precisely").toBe("affected");
    expect(querySpec.chapters.rust, "the query specification is a Rust input").toBe(true);
    expect(querySpec.rustPackages, "the query specification reaches graph-core").toEqual(
      expect.arrayContaining(["relayer-graph-core"]),
    );
    expect(querySpec.rustCrash, "the query specification keeps crash reconciliation fresh").toBe(true);
  });

  test("derives npm closures and desktop seams from package dependencies", () => {
    // Checkpoint 1: a graph-client change pulls its reverse dependents.
    const graphClient = plan("packages/graph-client/src/index.ts");
    expect(graphClient.mode, "graph-client maps precisely").toBe("affected");
    expect(graphClient.npmWorkspaces, "every dependent workspace joins the plan").toEqual([
      "@relayer/eval-runner",
      "@relayer/graph-client",
      "@relayer/harness-host",
      "relayer-desktop",
    ]);
    expect(graphClient.npmBuildWorkspaces, "dependent workspaces are all buildable").toEqual([
      "@relayer/eval-runner",
      "@relayer/graph-client",
      "@relayer/harness-host",
      "relayer-desktop",
    ]);
    expect(graphClient.chapters.typescript, "the TypeScript chapter is selected").toBe(true);
    expect(graphClient.chapters.vitest, "the Vitest chapter is selected").toBe(true);
    expect(graphClient.vitestFiles, "the source portfolio runs fresh").toEqual(
      expect.arrayContaining(["packages", "test"]),
    );
    expect(graphClient.chapters.packaging, "packaging stays unselected for package source").toBe(false);

    // Checkpoint 2: unchanged npm dependencies needed by a clean selected
    // build join the build closure.
    const harnessHost = plan("packages/harness-host/src/host.ts");
    expect(harnessHost.npmWorkspaces, "the affected closure covers harness-host dependents").toEqual([
      "@relayer/eval-runner",
      "@relayer/harness-host",
      "relayer-desktop",
    ]);
    expect(
      harnessHost.npmBuildWorkspaces,
      "a clean selected build includes the unchanged graph-client dependency",
    ).toContain("@relayer/graph-client");

    // Checkpoint 3: packaging is selected only for owned desktop inputs.
    const desktop = plan("desktop/main/index.mjs");
    expect(desktop.mode, "desktop maps precisely").toBe("affected");
    expect(desktop.npmWorkspaces, "only the desktop workspace is affected").toEqual(["relayer-desktop"]);
    expect(desktop.chapters.packaging, "owned desktop packaging inputs select packaging").toBe(true);
    expect(desktop.chapters.rust, "desktop packaging selects no Rust chapter").toBe(false);
    expect(desktop.rustCrash, "desktop packaging skips the crash lane").toBe(false);
    expect(desktop.runtimeRustPackages, "the runtime servers still ship for packaging").toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);
    expect(desktop.vitestFiles, "the source portfolio still runs fresh").toEqual(
      expect.arrayContaining(["packages", "test"]),
    );
    expect(desktop.vitestRustPackages, "mapped Vitest integration tests get both server binaries").toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);

    // Checkpoint 4: renderer changes build the server binaries their mapped
    // Vitest integration tests require.
    const workspace = plan("desktop/renderer/src/product-workspace/workspace.js");
    expect(workspace.vitestFiles, "the composer integration checkpoint joins the plan").toContain(
      "test/first-message-composer-integration.test.mjs",
    );
    expect(workspace.vitestRustPackages, "the integration checkpoint gets both server binaries").toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);

    // Checkpoint 5: the error catalog feeds the generated-code and Python
    // consumers; it is not a Rust input.
    const errorCatalog = plan("docs/graph-query-v1-errors.json");
    expect(errorCatalog.mode, "the error catalog maps precisely").toBe("affected");
    expect(errorCatalog.chapters.typescript, "generate-query-errors runs in the workspace check").toBe(true);
    expect(errorCatalog.chapters.python, "the Python client consumes the catalog").toBe(true);
    expect(errorCatalog.chapters.rust, "the catalog is not a Rust input").toBe(false);
    expect(errorCatalog.npmWorkspaces, "graph-client owns the generated code").toContain("@relayer/graph-client");
  });

  test("maps changed files to owning chapters and Vitest checkpoints", { timeout: 60_000 }, () => {
    const cases = [
      // Cross-cutting source and authority seams keep the complete fresh
      // Vitest portfolio.
      ["root source", "src/index.ts", { vitestFilesIncludes: ["packages", "test"] }],
      ["permission authority", "permissions/default.json", { vitestFilesIncludes: ["packages", "test"] }],
      ["harness authority", "harnesses/codex.json", { vitestFilesIncludes: ["packages", "test"] }],
      ["vendored runtime", "vendor/runtime.js", { vitestFilesIncludes: ["packages", "test"] }],
      [
        "bundled Python source flows through unit, integrity, and packaging gates",
        "python/relayer-graph/src/relayer_graph/client.py",
        {
          chapters: { python: true, vitest: true, packaging: true },
          vitestFilesIncludes: [
            "test/icon-vocabulary-parity.test.mjs",
            "test/prime-agent-packaging.test.mjs",
          ],
        },
      ],
      [
        "PRD changes route through readability and product-boundary checks",
        "docs/prd/index.html",
        {
          chapters: { prd: true, vitest: true },
          vitestFilesIncludes: ["test/documentation-product-boundary.test.mjs"],
        },
      ],
      [
        "root TypeScript tests stay in the semantic typecheck",
        "test/complete.test.ts",
        {
          chapters: { vitest: true },
          vitestFilesIncludes: ["test/complete.test.ts"],
          rootTypeScript: true,
        },
      ],
      [
        "CI-tested live-run model script maps to its checkpoint",
        "scripts/recursive-live-run-model.mjs",
        {
          chapters: { vitest: true },
          vitestFilesExact: ["test/recursive-live-run-model.test.mjs"],
        },
      ],
      [
        "Ladybug source preparation maps through Vitest, packaging, and receipt owners",
        "scripts/prepare-ladybug-source.mjs",
        {
          chapters: { vitest: true, packaging: true, receipts: true },
          vitestFilesIncludes: [
            "test/ladybug-packaged-lifecycle.test.mjs",
            "test/ladybug-source-build.test.mjs",
            "test/ladybug-native-receipts.test.mjs",
          ],
        },
      ],
      [
        "the release runbook maps to the desktop-shell checkpoint that reads it",
        "docs/desktop-release-operations.md",
        {
          chapters: { vitest: true },
          vitestFilesExact: ["test/desktop-shell.test.mjs"],
        },
      ],
      [
        "the provider-UX evidence browser maps to a CI-runnable checkpoint",
        "scripts/provider-ux-evidence-browser.mjs",
        {
          chapters: { vitest: true },
          vitestFilesExact: ["test/provider-electron-evidence.test.mjs"],
        },
      ],
      [
        "the provider-UX video capture maps to a CI-runnable checkpoint",
        "scripts/capture-provider-ux-video.mjs",
        {
          chapters: { vitest: true },
          vitestFilesExact: ["test/provider-electron-evidence.test.mjs"],
        },
      ],
      [
        "the live-run template maps to the model checkpoint",
        "live-run.example.json",
        {
          chapters: { vitest: true },
          vitestFilesExact: ["test/recursive-live-run-model.test.mjs"],
        },
      ],
      [
        "the live-run entry point maps to the model checkpoint",
        "scripts/run-recursive-live-run.mjs",
        {
          chapters: { vitest: true },
          vitestFilesExact: ["test/recursive-live-run-model.test.mjs"],
        },
      ],
      [
        ".gitattributes stays on every checkpoint that reads it",
        ".gitattributes",
        {
          chapters: { vitest: true },
          // prime-agent-packaging checks the harness/python eol pins; the
          // ladybug lifecycle test runs git check-attr over the receipt-input
          // paths and is the checkpoint that actually verifies the ladybug
          // LF pins.
          vitestFilesExact: [
            "test/ladybug-packaged-lifecycle.test.mjs",
            "test/prime-agent-packaging.test.mjs",
          ],
        },
      ],
      ["documentation-only path stays unmapped", "docs/research/intra-pr-ci-cache.md", { chaptersAllFalse: true }],
      ["manual driver script stays unmapped", "scripts/test-desktop-first-message.mjs", { chaptersAllFalse: true }],
      ["the LICENSE stays unmapped", "LICENSE", { chaptersAllFalse: true }],
      ["the .gitignore stays unmapped", ".gitignore", { chaptersAllFalse: true }],
    ];
    expect(cases).toHaveLength(19);
    for (const [label, changedFile, expected] of cases) {
      checkPlanRow(label, plan(changedFile), { ...expected, changedFile });
    }
  });

  test("builds the production Rust runtime required by each mapped Vitest file", () => {
    const cases = [
      [
        "test/conversation-export-eval-e2e.test.mjs",
        ["relayer-app-server", "relayer-graph-server"],
      ],
      [
        "test/eval-app-integration.test.mjs",
        ["relayer-app-server", "relayer-graph-server"],
      ],
      [
        "test/eval-managed-codex-runtime.test.mjs",
        ["relayer-app-server", "relayer-graph-server"],
      ],
      [
        "test/first-message-composer-integration.test.mjs",
        ["relayer-app-server", "relayer-graph-server"],
      ],
      ["test/graph-authoring-replay.test.mjs", ["relayer-graph-server"]],
      ["test/graph-search-client-parity-e2e.test.mjs", ["relayer-graph-server"]],
      [
        "test/provider-straightforward-flow.test.mjs",
        ["relayer-app-server", "relayer-graph-server"],
      ],
      [
        "test/recursive-complete-e2e.test.mjs",
        ["relayer-app-server", "relayer-graph-server"],
      ],
    ];
    expect(cases).toHaveLength(8);
    for (const [changedFile, expectedPackages] of cases) {
      expect.soft(
        plan(changedFile).vitestRustPackages,
        `${changedFile} builds exactly its required runtime binaries`,
      ).toEqual(expectedPackages);
    }
  });

  test("fails open to the full portfolio when mapping cannot stay precise", { timeout: 60_000 }, () => {
    const cases = [
      ["Cargo.lock", "Cargo.lock"],
      ["package-lock.json", "package-lock.json"],
      ["the CI workflow itself", ".github/workflows/ci.yml"],
      ["an evidence manifest", "docs/evidence/issue-257-browser-harnesses/manifest.json"],
      ["the query fixture corpus", "fixtures/graph-query-v1/positive.json"],
      ["an unmapped new seam", "unmapped/new-seam.txt"],
      // CI-tooling scripts stay on the full portfolio.
      ["CI-tooling scripts", "scripts/check-node-version.mjs"],
      // Single-file owners stay exact instead of prefix-matched.
      ["exact-only spec owners are not prefix-matched", "docs/graph-query-v1.mdx"],
    ];
    expect(cases).toHaveLength(8);
    for (const [label, changedFile] of cases) {
      const result = plan(changedFile);
      expect.soft(result.mode, `${label}: ${changedFile} fails open to full`).toBe("full");
      expect.soft(
        Object.values(result.chapters).every(Boolean),
        `${label}: ${changedFile} selects every chapter`,
      ).toBe(true);
      expect.soft(result.reasons.join(" "), `${label}: the reason names ${changedFile}`).toContain(changedFile);
    }

    // A deleted test must fail open instead of becoming the only filter.
    const deleted = plan("test/retired-ci-test.test.mjs");
    expect(deleted.mode, "a deleted test path fails open to full").toBe("full");
    expect(deleted.reasons.join(" "), "the reason names the deleted test path").toContain("deleted test path");
  });

  test("guards every exempted path declaration against drift", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const exempted = [...config.chapterOwners, ...config.scriptOwners].filter(
      (owner) => owner.exact && (owner.chapters ?? []).length === 0,
    );
    expect(exempted.length, "the exemption corpus stays substantial").toBeGreaterThan(20);

    // CI contract tests necessarily name mapped paths; they are not product
    // consumers of them.
    const ciContractTests = new Set([
      "ci-affected-plan.test.mjs",
      "ci-chapter-runner.test.mjs",
      "ci-required-check.test.mjs",
      "ci-runtime-artifact.test.mjs",
      "ci-verification-portfolio.test.mjs",
    ]);
    // Scan the top-level suite and the workspace test roots the planner
    // knows about; substring matching cannot see paths assembled with join()
    // or new URL(), so a missed reference is possible but the roots cover
    // the mapped consumers.
    const corpusRoots = [
      join(repositoryRoot, "test"),
      join(repositoryRoot, "packages", "eval-runner", "test"),
      join(repositoryRoot, "packages", "graph-client", "test"),
      join(repositoryRoot, "packages", "harness-host", "test"),
    ];
    const testCorpus = corpusRoots
      .flatMap((root) =>
        existsSync(root)
          ? readdirSync(root).map((name) => join(root, name))
          : [],
      )
      .filter(
        (filePath) =>
          /\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath) &&
          !ciContractTests.has(basename(filePath)),
      )
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");

    // Verified references that do not consume the repository file in CI.
    // Each one must keep matching, or the guard fails and the exemption
    // needs a fresh review.
    const verifiedReferences = {
      ".gitignore":
        "evidence-capture-integrity.test.mjs writes a temp-directory .gitignore fixture",
      LICENSE:
        "ladybug-native-receipts.test.mjs matches OpenSSL LICENSE.txt fixture names only",
    };

    for (const owner of exempted) {
      expect(existsSync(join(repositoryRoot, owner.exact)), `${owner.exact}: the exempted path must exist`).toBe(true);
      const referenced = testCorpus.includes(owner.exact);
      if (owner.exact in verifiedReferences) {
        expect(
          referenced,
          `${owner.exact}: verified reference disappeared, re-review the exemption`,
        ).toBe(true);
        continue;
      }
      expect(
        referenced,
        `${owner.exact}: a test now references this exempted path, give it that checkpoint`,
      ).toBe(false);
    }
    for (const owner of [...config.chapterOwners, ...config.scriptOwners]) {
      if (!owner.prefix || (owner.chapters ?? []).length > 0) continue;
      expect(existsSync(join(repositoryRoot, owner.prefix)), `${owner.prefix}: the exempted prefix must exist`).toBe(true);
      expect(testCorpus.includes(owner.prefix), `${owner.prefix}: a test now references this exempted prefix`).toBe(false);
    }
  });
});

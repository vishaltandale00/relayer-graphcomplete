import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

describe("affected-module plan v1", () => {
  test("is a checked-in versioned contract", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.version).toBe(1);
    expect(config.rustCrashPackages).toEqual([
      "relayer-graph-core",
      "relayer-graph-server",
    ]);
  });

  test("full integration mode does not depend on a diff base", () => {
    const result = fullPlanWithoutDiff();

    expect(result.mode).toBe("full");
    expect(Object.values(result.chapters).every(Boolean)).toBe(true);
    expect(result.vitestFiles).toEqual([]);
    expect(result.rustCrash).toBe(true);
    expect(result.runtimeRustPackages).toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);
  });

  test.each([
    [{ eventName: "push", headRef: "" }, "full"],
    [{ eventName: "push", headRef: "integration/cache-baseline" }, "full"],
    [{ eventName: "pull_request", headRef: "integration/issue-360" }, "full"],
    [
      { eventName: "pull_request", headRef: "component/graph-core" },
      "affected",
    ],
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
    expect(result.rustCrash).toBe(true);
    expect(result.runtimeRustPackages).toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);
    expect(result.chapters.vitest).toBe(true);
    expect(result.npmBuildWorkspaces).toEqual(
      expect.arrayContaining([
        "@relayer/eval-runner",
        "@relayer/graph-client",
        "@relayer/harness-host",
      ]),
    );
    expect(result.vitestFiles).toEqual(
      expect.arrayContaining(["packages", "test"]),
    );
    expect(result.chapters.packaging).toBe(false);
  });

  test("keeps crash reconciliation fresh for graph-crate changes and their dependents", () => {
    expect(plan("crates/relayer-graph-core/src/graph.rs").rustCrash).toBe(true);
    expect(plan("crates/relayer-graph-server/src/main.rs").rustCrash).toBe(
      true,
    );
    // Telemetry changes flow into graph-server through the dependency
    // closure, so the crash portfolio stays fresh for them too.
    expect(
      plan("crates/relayer-telemetry-capability/src/lib.rs").rustCrash,
    ).toBe(true);
  });

  test("skips the crash lane for app-server-only changes it does not exercise", () => {
    const result = plan("crates/relayer-app-server/src/main.rs");

    expect(result.mode).toBe("affected");
    expect(result.rustPackages).toEqual(["relayer-app-server"]);
    expect(result.chapters.rust).toBe(true);
    // The crash command compiles and runs no app-server code; app-server
    // interrupted-execution recovery stays owned by its ordinary tests.
    expect(result.rustCrash).toBe(false);
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
    expect(result.vitestFiles).toEqual(
      expect.arrayContaining(["packages", "test"]),
    );
    expect(result.chapters.packaging).toBe(false);
  });

  test("includes unchanged npm dependencies needed by a clean selected build", () => {
    const result = plan("packages/harness-host/src/host.ts");

    expect(result.npmWorkspaces).toEqual([
      "@relayer/eval-runner",
      "@relayer/harness-host",
      "relayer-desktop",
    ]);
    expect(result.npmBuildWorkspaces).toContain("@relayer/graph-client");
  });

  test("selects packaging only for owned desktop packaging inputs", () => {
    const result = plan("desktop/main/index.mjs");

    expect(result.mode).toBe("affected");
    expect(result.npmWorkspaces).toEqual(["relayer-desktop"]);
    expect(result.chapters.packaging).toBe(true);
    expect(result.chapters.rust).toBe(false);
    expect(result.rustCrash).toBe(false);
    expect(result.runtimeRustPackages).toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);
    expect(result.vitestFiles).toEqual(
      expect.arrayContaining(["packages", "test"]),
    );
    expect(result.vitestRustPackages).toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);
  });

  test("builds server binaries required by mapped Vitest integration tests", () => {
    const result = plan("desktop/renderer/src/product-workspace/workspace.js");

    expect(result.vitestFiles).toContain(
      "test/first-message-composer-integration.test.mjs",
    );
    expect(result.vitestRustPackages).toEqual([
      "relayer-app-server",
      "relayer-graph-server",
    ]);
  });

  test.each([
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
  ])(
    "builds the production Rust runtime required by %s",
    (changedFile, expectedPackages) => {
      expect(plan(changedFile).vitestRustPackages).toEqual(expectedPackages);
    },
  );

  test("keeps cross-cutting source and authority seams on the complete fresh Vitest portfolio", () => {
    for (const changedFile of [
      "src/index.ts",
      "permissions/default.json",
      "harnesses/codex.json",
      "vendor/runtime.js",
    ]) {
      expect(plan(changedFile).vitestFiles).toEqual(
        expect.arrayContaining(["packages", "test"]),
      );
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
    if (changedFile.startsWith("test/"))
      expect(result.vitestFiles).toContain(changedFile);
  });

  test("routes PRD changes through readability and product-boundary checks", () => {
    const result = plan("docs/prd/index.html");

    expect(result.chapters.prd).toBe(true);
    expect(result.chapters.vitest).toBe(true);
    expect(result.vitestFiles).toContain(
      "test/documentation-product-boundary.test.mjs",
    );
  });

  test("routes bundled Python source through unit, integrity, and packaging gates", () => {
    const result = plan("python/relayer-graph/src/relayer_graph/client.py");

    expect(result.chapters.python).toBe(true);
    expect(result.chapters.vitest).toBe(true);
    expect(result.chapters.packaging).toBe(true);
    expect(result.vitestFiles).toEqual(
      expect.arrayContaining([
        "test/icon-vocabulary-parity.test.mjs",
        "test/prime-agent-packaging.test.mjs",
      ]),
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

  test("maps CI-tested scripts to their owning Vitest checkpoints", () => {
    const result = plan("scripts/recursive-live-run-model.mjs");

    expect(result.mode).toBe("affected");
    expect(result.chapters.vitest).toBe(true);
    expect(result.vitestFiles).toEqual([
      "test/recursive-live-run-model.test.mjs",
    ]);
  });

  test("maps Ladybug source preparation through Vitest and packaging owners", () => {
    const result = plan("scripts/prepare-ladybug-source.mjs");

    expect(result.mode).toBe("affected");
    expect(result.chapters.vitest).toBe(true);
    expect(result.chapters.packaging).toBe(true);
    expect(result.vitestFiles).toEqual(
      expect.arrayContaining([
        "test/ladybug-packaged-lifecycle.test.mjs",
        "test/ladybug-source-build.test.mjs",
      ]),
    );
  });

  test("maps the frozen query specification into the graph-core Rust closure", () => {
    const result = plan("docs/graph-query-v1.md");

    expect(result.mode).toBe("affected");
    expect(result.chapters.rust).toBe(true);
    expect(result.rustPackages).toEqual(
      expect.arrayContaining(["relayer-graph-core"]),
    );
    expect(result.rustCrash).toBe(true);
  });

  test("maps the error catalog to the generated-code and Python consumers", () => {
    const result = plan("docs/graph-query-v1-errors.json");

    expect(result.mode).toBe("affected");
    // The catalog feeds generate-query-errors --check in the graph-client
    // workspace check and the Python client tests; it is not a Rust input.
    expect(result.chapters.typescript).toBe(true);
    expect(result.chapters.python).toBe(true);
    expect(result.chapters.rust).toBe(false);
    expect(result.npmWorkspaces).toContain("@relayer/graph-client");
  });

  test("maps the release runbook to the desktop-shell checkpoint that reads it", () => {
    const result = plan("docs/desktop-release-operations.md");

    expect(result.mode).toBe("affected");
    expect(result.chapters.vitest).toBe(true);
    expect(result.vitestFiles).toEqual(["test/desktop-shell.test.mjs"]);
  });

  test("maps the provider-UX evidence scripts to no chapter", () => {
    // Their only executing consumer is macOS-media-tools gated and skips on
    // the Ubuntu CI runner, so no checkpoint observes them there; claiming a
    // Vitest owner would satisfy the mapping guard with a test that cannot
    // run. The exempted-script guard below polices the declarations.
    for (const changedFile of [
      "scripts/provider-ux-evidence-browser.mjs",
      "scripts/capture-provider-ux-video.mjs",
    ]) {
      const result = plan(changedFile);

      expect(result.mode).toBe("affected");
      expect(Object.values(result.chapters).some(Boolean)).toBe(false);
    }
  });

  test("guards every exempted path declaration against drift", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const exempted = [...config.chapterOwners, ...config.scriptOwners].filter(
      (owner) => owner.exact && (owner.chapters ?? []).length === 0,
    );
    expect(exempted.length).toBeGreaterThan(20);

    // CI contract tests necessarily name mapped paths; they are not product
    // consumers of them.
    const ciContractTests = new Set([
      "ci-affected-plan.test.mjs",
      "ci-chapter-runner.test.mjs",
      "ci-required-check.test.mjs",
      "ci-runtime-artifact.test.mjs",
      "ci-verification-portfolio.test.mjs",
    ]);
    const testCorpus = readdirSync(join(repositoryRoot, "test"))
      .filter(
        (name) =>
          /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) &&
          !ciContractTests.has(name),
      )
      .map((name) =>
        readFileSync(join(repositoryRoot, "test", name), "utf8"),
      )
      .join("\n");

    // Verified references that do not consume the repository file in CI.
    // Each one must keep matching, or the guard fails and the exemption
    // needs a fresh review.
    const verifiedReferences = {
      ".gitignore":
        "evidence-capture-integrity.test.mjs writes a temp-directory .gitignore fixture",
      LICENSE:
        "ladybug-native-receipts.test.mjs matches OpenSSL LICENSE.txt fixture names only",
      "scripts/capture-provider-ux-video.mjs":
        "provider-electron-evidence.test.mjs consumer is macOS-media gated and skips on CI runners",
    };

    for (const owner of exempted) {
      expect(existsSync(join(repositoryRoot, owner.exact))).toBe(true);
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
      expect(existsSync(join(repositoryRoot, owner.prefix))).toBe(true);
      expect(testCorpus.includes(owner.prefix)).toBe(false);
    }
  });

  test("maps documentation-only and manual-driver paths to no chapter", () => {
    for (const changedFile of [
      "LICENSE",
      ".gitignore",
      "docs/research/intra-pr-ci-cache.md",
      "scripts/test-desktop-first-message.mjs",
    ]) {
      const result = plan(changedFile);

      expect(result.mode).toBe("affected");
      expect(Object.values(result.chapters).some(Boolean)).toBe(false);
    }
  });

  test("keeps .gitattributes on every checkpoint that reads it", () => {
    const result = plan(".gitattributes");

    expect(result.mode).toBe("affected");
    expect(result.chapters.vitest).toBe(true);
    // prime-agent-packaging checks the harness/python eol pins; the ladybug
    // lifecycle test runs git check-attr over the receipt-input paths and is
    // the checkpoint that actually verifies the ladybug LF pins.
    expect(result.vitestFiles).toEqual([
      "test/ladybug-packaged-lifecycle.test.mjs",
      "test/prime-agent-packaging.test.mjs",
    ]);
  });

  test("keeps single-file owners exact instead of prefix-matched", () => {
    const result = plan("docs/graph-query-v1.mdx");

    expect(result.mode).toBe("full");
    expect(result.reasons.join(" ")).toContain("docs/graph-query-v1.mdx");
  });

  test("keeps CI-tooling scripts on the full portfolio", () => {
    const result = plan("scripts/check-node-version.mjs");

    expect(result.mode).toBe("full");
    expect(result.reasons.join(" ")).toContain(
      "scripts/check-node-version.mjs",
    );
  });

  test.each([
    "Cargo.lock",
    "package-lock.json",
    ".github/workflows/ci.yml",
    "docs/evidence/issue-257-browser-harnesses/manifest.json",
    "fixtures/graph-query-v1/positive.json",
    "unmapped/new-seam.txt",
  ])("fails open to the full portfolio for %s", (changedFile) => {
    const result = plan(changedFile);

    expect(result.mode).toBe("full");
    expect(Object.values(result.chapters).every(Boolean)).toBe(true);
    expect(result.reasons.join(" ")).toContain(changedFile);
  });
});

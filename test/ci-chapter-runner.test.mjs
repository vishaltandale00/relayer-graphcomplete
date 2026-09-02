import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(repositoryRoot, "scripts", "ci", "run-chapter.mjs");

// A cargo stub that records its invocation and, when --timings is present,
// emits the report Cargo would write into the target directory.
const TIMINGS_CARGO_STUB = '#!/bin/sh\necho "cargo:$*" >> "$TRACE"\ncase " $* " in\n  *--timings*) mkdir -p "$CARGO_TARGET_DIR/cargo-timings" && echo "<html></html>" > "$CARGO_TARGET_DIR/cargo-timings/cargo-timing.html" ;;\nesac\n';

// Each case gets its own fresh temp directory and stubbed PATH so traces and
// timing directories from one scenario can never leak into another.
function withChapterSandbox(caseBody) {
  const directory = mkdtempSync(join(tmpdir(), "relayer-ci-chapter-"));
  const trace = join(directory, "trace.txt");
  const invocationTrace = join(directory, "invocations.jsonl");
  try {
    writeFileSync(invocationTrace, "");
    for (const command of ["cargo", "git", "node", "npm", "npx", "python3"]) {
      const executable = join(directory, command);
      writeFileSync(
        executable,
        `#!/bin/sh\necho "${command}:$*" >> "$TRACE"\n`,
      );
      chmodSync(executable, 0o755);
    }
    const run = (chapter, plan, env = {}) => {
      execFileSync(process.execPath, [runner, chapter], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          // Pin the timing inputs so ambient exports cannot flip these tests
          // into the --timings branch or move a real report as a side effect.
          // GITHUB_STEP_SUMMARY points at a scratch file so spawned failures
          // never write triage lines into the real CI job summary.
          CARGO_TARGET_DIR: join(directory, "cargo-target"),
          RELAYER_CARGO_TIMINGS_DIR: "",
          GITHUB_STEP_SUMMARY: join(directory, "step-summary.md"),
          CI_PLAN_JSON: JSON.stringify(plan),
          CI_INVOCATION_TRACE: invocationTrace,
          PATH: `${directory}:${process.env.PATH}`,
          TRACE: trace,
          ...env,
        },
      });
      return readFileSync(trace, "utf8").trim().split("\n");
    };
    return caseBody({
      directory,
      trace,
      invocationTrace,
      run,
      resetTrace: () => writeFileSync(trace, ""),
      setCargoStub: (body) => {
        writeFileSync(join(directory, "cargo"), body);
        chmodSync(join(directory, "cargo"), 0o755);
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("CI chapter runner", () => {
  test("runs each Rust lane as the exact fresh Cargo invocation and harvests timing reports on success and failure", () => {
    // Case 1: Clippy and default tests are separate fresh invocations, and
    // neither carries --timings while no timings directory is configured.
    withChapterSandbox(({ run, resetTrace }) => {
      const plan = {
        rustPackages: ["relayer-graph-core", "relayer-graph-server"],
      };
      expect(
        run("rust-clippy", plan),
        "Clippy lints the selected packages in one fresh invocation",
      ).toEqual([
        "cargo:clippy -p relayer-graph-core -p relayer-graph-server --all-targets --all-features -- -D warnings",
      ]);
      resetTrace();
      expect(
        run("rust-tests", plan),
        "default tests run in their own separate invocation",
      ).toEqual([
        "cargo:test -p relayer-graph-core -p relayer-graph-server",
      ]);
    });

    // Case 2: a configured timings directory adds --timings and moves the
    // report out of the target directory under the lane name.
    withChapterSandbox(({ directory, run, setCargoStub }) => {
      const timingsDirectory = join(directory, "timings");
      const targetDirectory = join(directory, "cargo-target");
      setCargoStub(TIMINGS_CARGO_STUB);
      expect(
        run("rust-tests", { rustPackages: ["relayer-graph-core"] }, {
          CARGO_TARGET_DIR: targetDirectory,
          RELAYER_CARGO_TIMINGS_DIR: timingsDirectory,
        }),
        "the test lane gains --timings when a timings directory is set",
      ).toEqual(["cargo:test -p relayer-graph-core --timings"]);
      expect(
        readdirSync(timingsDirectory),
        "the harvested report is renamed after its lane",
      ).toEqual(["rust-tests.html"]);
      expect(
        existsSync(join(targetDirectory, "cargo-timings", "cargo-timing.html")),
        "the raw report is moved out of the target directory",
      ).toBe(false);
    });

    // Case 3: Clippy keeps --timings before the lint argument separator.
    withChapterSandbox(({ directory, run, setCargoStub }) => {
      const timingsDirectory = join(directory, "timings-clippy");
      const targetDirectory = join(directory, "cargo-target-clippy");
      setCargoStub(TIMINGS_CARGO_STUB);
      expect(
        run("rust-clippy", { rustPackages: ["relayer-graph-core"] }, {
          CARGO_TARGET_DIR: targetDirectory,
          RELAYER_CARGO_TIMINGS_DIR: timingsDirectory,
        }),
        "--timings stays before the Clippy lint argument separator",
      ).toEqual([
        "cargo:clippy -p relayer-graph-core --all-targets --all-features --timings -- -D warnings",
      ]);
      expect(
        readdirSync(timingsDirectory),
        "the Clippy report is harvested under the lane name",
      ).toEqual(["rust-clippy.html"]);
    });

    // Case 4: the timing report survives a failing Cargo invocation.
    withChapterSandbox(({ directory, run, setCargoStub }) => {
      const timingsDirectory = join(directory, "timings-failed");
      const targetDirectory = join(directory, "cargo-target-failed");
      setCargoStub(`${TIMINGS_CARGO_STUB}exit 101\n`);
      expect(
        () =>
          run("rust-tests", { rustPackages: ["relayer-graph-core"] }, {
            CARGO_TARGET_DIR: targetDirectory,
            RELAYER_CARGO_TIMINGS_DIR: timingsDirectory,
          }),
        "the failed Cargo invocation still fails the chapter",
      ).toThrow();
      // The report exists to diagnose exactly the runs that fail; losing it
      // on the failure path would defeat its purpose.
      expect(
        readdirSync(timingsDirectory),
        "the timing report is harvested even when Cargo fails",
      ).toEqual(["rust-tests.html"]);
    });

    // Case 5: the runtime lane builds only planner-selected packages and the
    // crash lane stays on the fresh reconciliation check.
    withChapterSandbox(({ run, resetTrace }) => {
      expect(
        run("rust-runtime", { runtimeRustPackages: ["relayer-graph-server"] }),
        "the runtime lane builds exactly the planner-selected packages",
      ).toEqual(["cargo:build -p relayer-graph-server"]);
      resetTrace();
      expect(
        run("rust-crash", {}),
        "the crash lane runs the graph crash reconciliation check",
      ).toEqual(["npm:run check:graph-crash-reconciliation"]);
    });
  });

  test("executes the machine-readable authority and prerequisite contract for every portfolio chapter", () => {
    const portfolio = JSON.parse(
      readFileSync(
        join(repositoryRoot, "scripts", "ci", "verification-portfolio.v1.json"),
        "utf8",
      ),
    );
    const fullPlan = {
      mode: "full",
      rustPackages: [
        "relayer-app-server",
        "relayer-graph-core",
        "relayer-graph-server",
      ],
      runtimeRustPackages: ["relayer-app-server", "relayer-graph-server"],
      npmBuildWorkspaces: [
        "@relayer/graph-client",
        "@relayer/harness-host",
        "@relayer/eval-runner",
      ],
      npmWorkspaces: [
        "@relayer/graph-client",
        "@relayer/harness-host",
        "@relayer/eval-runner",
      ],
      rootTypeScript: true,
      vitestFiles: [],
    };

    withChapterSandbox(({ run, trace, invocationTrace }) => {
      for (const [chapter, expected] of Object.entries(portfolio.chapters)) {
        writeFileSync(trace, "");
        writeFileSync(invocationTrace, "");
        run(chapter, fullPlan);
        const actual = readFileSync(invocationTrace, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        for (const role of ["authority", "prerequisite"]) {
          expect(
            new Set(
              actual
                .filter((invocation) => invocation.role === role)
                .map((invocation) => invocation.id),
            ),
            `${chapter}: ${role} invocations must match the portfolio contract`,
          ).toEqual(
            new Set(
              expected[role === "authority" ? "authorities" : "prerequisites"],
            ),
          );
        }
      }
    });
  });
});

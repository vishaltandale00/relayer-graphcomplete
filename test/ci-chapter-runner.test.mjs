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
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(repositoryRoot, "scripts", "ci", "run-chapter.mjs");

describe("CI chapter runner", () => {
  let directory;
  let invocationTrace;
  let trace;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "relayer-ci-chapter-"));
    trace = join(directory, "trace.txt");
    invocationTrace = join(directory, "invocations.jsonl");
    writeFileSync(invocationTrace, "");
    for (const command of ["cargo", "git", "node", "npm", "npx", "python3"]) {
      const executable = join(directory, command);
      writeFileSync(
        executable,
        `#!/bin/sh\necho "${command}:$*" >> "$TRACE"\n`,
      );
      chmodSync(executable, 0o755);
    }
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function run(chapter, plan) {
    execFileSync(process.execPath, [runner, chapter], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        // Pin the timing inputs so ambient exports cannot flip these tests
        // into the --timings branch or move a real report as a side effect.
        CARGO_TARGET_DIR: join(directory, "cargo-target"),
        RELAYER_CARGO_TIMINGS_DIR: "",
        CI_PLAN_JSON: JSON.stringify(plan),
        CI_INVOCATION_TRACE: invocationTrace,
        PATH: `${directory}:${process.env.PATH}`,
        TRACE: trace,
      },
    });
    return readFileSync(trace, "utf8").trim().split("\n");
  }

  test("executes Clippy and default tests as separate fresh Cargo invocations", () => {
    const plan = {
      rustPackages: ["relayer-graph-core", "relayer-graph-server"],
    };
    expect(run("rust-clippy", plan)).toEqual([
      "cargo:clippy -p relayer-graph-core -p relayer-graph-server --all-targets --all-features -- -D warnings",
    ]);
    writeFileSync(trace, "");
    expect(run("rust-tests", plan)).toEqual([
      "cargo:test -p relayer-graph-core -p relayer-graph-server",
    ]);
  });

  test("keeps Cargo invocations timing-free unless a timings directory is set", () => {
    const plan = { rustPackages: ["relayer-graph-core"] };
    expect(run("rust-tests", plan)).toEqual([
      "cargo:test -p relayer-graph-core",
    ]);
  });

  test("adds --timings and harvests the report when a timings directory is set", () => {
    const timingsDirectory = join(directory, "timings");
    const targetDirectory = join(directory, "cargo-target");
    writeFileSync(trace, "");
    writeFileSync(
      join(directory, "cargo"),
      '#!/bin/sh\necho "cargo:$*" >> "$TRACE"\ncase " $* " in\n  *--timings*) mkdir -p "$CARGO_TARGET_DIR/cargo-timings" && echo "<html></html>" > "$CARGO_TARGET_DIR/cargo-timings/cargo-timing.html" ;;\nesac\n',
    );
    chmodSync(join(directory, "cargo"), 0o755);
    execFileSync(
      process.execPath,
      [runner, "rust-tests"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDirectory,
          CI_PLAN_JSON: JSON.stringify({ rustPackages: ["relayer-graph-core"] }),
          CI_INVOCATION_TRACE: invocationTrace,
          PATH: `${directory}:${process.env.PATH}`,
          RELAYER_CARGO_TIMINGS_DIR: timingsDirectory,
          TRACE: trace,
        },
      },
    );
    expect(readFileSync(trace, "utf8").trim()).toBe(
      "cargo:test -p relayer-graph-core --timings",
    );
    expect(readdirSync(timingsDirectory)).toEqual(["rust-tests.html"]);
    expect(
      existsSync(join(targetDirectory, "cargo-timings", "cargo-timing.html")),
    ).toBe(false);
  });

  test("keeps --timings before the Clippy lint argument separator", () => {
    const timingsDirectory = join(directory, "timings-clippy");
    const targetDirectory = join(directory, "cargo-target-clippy");
    writeFileSync(
      join(directory, "cargo"),
      '#!/bin/sh\necho "cargo:$*" >> "$TRACE"\ncase " $* " in\n  *--timings*) mkdir -p "$CARGO_TARGET_DIR/cargo-timings" && echo "<html></html>" > "$CARGO_TARGET_DIR/cargo-timings/cargo-timing.html" ;;\nesac\n',
    );
    chmodSync(join(directory, "cargo"), 0o755);
    execFileSync(
      process.execPath,
      [runner, "rust-clippy"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDirectory,
          CI_PLAN_JSON: JSON.stringify({ rustPackages: ["relayer-graph-core"] }),
          CI_INVOCATION_TRACE: invocationTrace,
          PATH: `${directory}:${process.env.PATH}`,
          RELAYER_CARGO_TIMINGS_DIR: timingsDirectory,
          TRACE: trace,
        },
      },
    );
    expect(readFileSync(trace, "utf8").trim()).toBe(
      "cargo:clippy -p relayer-graph-core --all-targets --all-features --timings -- -D warnings",
    );
    expect(readdirSync(timingsDirectory)).toEqual(["rust-clippy.html"]);
  });

  test("harvests the timing report even when the Cargo invocation fails", () => {
    const timingsDirectory = join(directory, "timings-failed");
    const targetDirectory = join(directory, "cargo-target-failed");
    writeFileSync(trace, "");
    writeFileSync(
      join(directory, "cargo"),
      '#!/bin/sh\necho "cargo:$*" >> "$TRACE"\ncase " $* " in\n  *--timings*) mkdir -p "$CARGO_TARGET_DIR/cargo-timings" && echo "<html></html>" > "$CARGO_TARGET_DIR/cargo-timings/cargo-timing.html" ;;\nesac\nexit 101\n',
    );
    chmodSync(join(directory, "cargo"), 0o755);
    expect(() =>
      execFileSync(process.execPath, [runner, "rust-tests"], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDirectory,
          CI_PLAN_JSON: JSON.stringify({ rustPackages: ["relayer-graph-core"] }),
          CI_INVOCATION_TRACE: invocationTrace,
          PATH: `${directory}:${process.env.PATH}`,
          RELAYER_CARGO_TIMINGS_DIR: timingsDirectory,
          TRACE: trace,
        },
      }),
    ).toThrow();
    // The report exists to diagnose exactly the runs that fail; losing it on
    // the failure path would defeat its purpose.
    expect(readdirSync(timingsDirectory)).toEqual(["rust-tests.html"]);
  });

  test("builds only the planner-selected runtime and keeps crash tests fresh", () => {
    expect(
      run("rust-runtime", { runtimeRustPackages: ["relayer-graph-server"] }),
    ).toEqual(["cargo:build -p relayer-graph-server"]);
    writeFileSync(trace, "");
    expect(run("rust-crash", {})).toEqual([
      "npm:run check:graph-crash-reconciliation",
    ]);
  });

  test("executes the machine-readable authority and prerequisite contract", () => {
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
        ).toEqual(
          new Set(
            expected[role === "authority" ? "authorities" : "prerequisites"],
          ),
        );
      }
    }
  });
});

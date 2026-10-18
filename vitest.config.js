import { defineConfig } from "vitest/config";

const exclude = ["**/node_modules/**", "**/.git/**", "**/.relayer/**"];

// Files that drive real processes whose readiness is timing-sensitive: the
// headless-browser evidence capture paints blank frames when starved of CPU,
// and the desktop shell's shutdown tests observe signal ordering.
// Native Mach-O closure sealing and calibration Git/npm verifier journeys also
// exceed their individual bounds under portfolio-wide subprocess contention.
// These files run one at a time after the isolated group so they never share
// the machine with other workers. Every other file owns its temporary state and
// shares at most three file workers, matching the shared 4-vCPU CI runner.
// Larger hosts retain this cap because native query budgets do not scale with
// portfolio parallelism.
const processBound = [
  "test/desktop-shell.test.mjs",
  "test/provider-electron-evidence.test.mjs",
  "test/evidence-capture-integrity.test.mjs",
  "packages/eval-runner/test/calibration-autonomous-cases.test.ts",
];

// Tests that spawn the Rust runtime or a harness host take two to five
// seconds on a shared 4-vCPU runner once three file workers share the machine,
// so Vitest's 5 s default timeout measured runner throughput rather than the
// behavior under test. Both projects inherit this bound through `extends`;
// a test that needs longer still sets its own.
const testTimeout = 15_000;

export default defineConfig({
  test: {
    exclude,
    testTimeout,
    projects: [
      {
        extends: true,
        test: { name: "isolated", maxWorkers: 3, exclude: [...exclude, ...processBound] },
      },
      {
        extends: true,
        test: {
          name: "process-bound",
          include: processBound,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { validateVerificationPortfolio } from "../scripts/ci/verification-portfolio.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function loadManifest() {
  return JSON.parse(
    readFileSync(
      join(repositoryRoot, "scripts", "ci", "verification-portfolio.v1.json"),
      "utf8",
    ),
  );
}

describe("versioned verification portfolio", () => {
  test("gives every required command exactly one CI authority and rejects ownership violations", () => {
    const manifest = loadManifest();

    expect(manifest.version, "the portfolio stays on version 1").toBe(1);
    expect(
      validateVerificationPortfolio(repositoryRoot, manifest),
      "the checked-in portfolio validates cleanly",
    ).toEqual({ ok: true, failures: [] });
    expect(
      new Set(Object.values(manifest.commands).map((command) => command.owner)),
      "every CI authority lane owns at least one command",
    ).toEqual(
      new Set([
        "quick",
        "rust-clippy",
        "rust-tests",
        "rust-crash",
        "rust-runtime",
        "typescript",
        "vitest",
        "python",
        "receipts",
        "prd",
      ]),
    );
    const workflow = parse(
      readFileSync(
        join(repositoryRoot, ".github", "workflows", "ci.yml"),
        "utf8",
      ),
    );
    for (const command of Object.values(manifest.commands)) {
      expect(
        workflow.jobs[command.owner],
        `the workflow keeps a job for the ${command.owner} authority`,
      ).toBeDefined();
    }
    expect(workflow.jobs.full, "no duplicate full gate job exists").toBeUndefined();

    // Adversarial ownership variants: each mutation must be rejected with a
    // failure that names the offending command.
    const cases = [
      [
        "a command claimed by a second authority",
        (candidate) => {
          candidate.commands[candidate.scripts.check[0]].owner = ["quick", "full"];
        },
        `${manifest.scripts.check[0]}: expected exactly one CI owner`,
      ],
      [
        "an owner that does not execute the command authority",
        (candidate) => {
          candidate.commands["rust-clippy"].owner = "quick";
        },
        "rust-clippy: declared owner quick does not match rust-clippy job rust-clippy",
      ],
      [
        "a required command missing from the runner authority contract",
        (candidate) => {
          candidate.chapters["rust-tests"].authorities = [];
        },
        "rust-tests: expected one authoritative chapter, received 0",
      ],
    ];
    expect(cases).toHaveLength(3);
    for (const [label, mutate, expectedFailure] of cases) {
      const candidate = loadManifest();
      mutate(candidate);
      expect.soft(
        validateVerificationPortfolio(repositoryRoot, candidate).failures,
        label,
      ).toContain(expectedFailure);
    }
  });
});

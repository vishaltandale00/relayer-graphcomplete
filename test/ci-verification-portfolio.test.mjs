import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { validateVerificationPortfolio } from "../scripts/ci/verification-portfolio.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("versioned verification portfolio", () => {
  test("gives every repository-required check and build command exactly one CI authority", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "scripts", "ci", "verification-portfolio.v1.json"),
        "utf8",
      ),
    );

    expect(manifest.version).toBe(1);
    expect(validateVerificationPortfolio(repositoryRoot, manifest)).toEqual({
      ok: true,
      failures: [],
    });
    expect(
      new Set(Object.values(manifest.commands).map((command) => command.owner)),
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
    for (const command of Object.values(manifest.commands))
      expect(workflow.jobs[command.owner]).toBeDefined();
    expect(workflow.jobs.full).toBeUndefined();
  });

  test("rejects a command with a second authority", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "scripts", "ci", "verification-portfolio.v1.json"),
        "utf8",
      ),
    );
    manifest.commands[manifest.scripts.check[0]].owner = ["quick", "full"];

    expect(
      validateVerificationPortfolio(repositoryRoot, manifest).failures,
    ).toContain(`${manifest.scripts.check[0]}: expected exactly one CI owner`);
  });

  test("rejects an owner that does not execute the command authority", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "scripts", "ci", "verification-portfolio.v1.json"),
        "utf8",
      ),
    );
    manifest.commands["rust-clippy"].owner = "quick";

    expect(
      validateVerificationPortfolio(repositoryRoot, manifest).failures,
    ).toContain(
      "rust-clippy: declared owner quick does not match rust-clippy job rust-clippy",
    );
  });

  test("rejects a required command missing from the runner authority contract", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "scripts", "ci", "verification-portfolio.v1.json"),
        "utf8",
      ),
    );
    manifest.chapters["rust-tests"].authorities = [];

    expect(
      validateVerificationPortfolio(repositoryRoot, manifest).failures,
    ).toContain("rust-tests: expected one authoritative chapter, received 0");
  });
});

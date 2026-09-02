import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { h3AutonomousCases, h3VerifierDigest } from "../src/index.js";

describe("h3 autonomous seed cases", () => {
  it("binds one concise autonomous prompt per frozen case to the checked-in sealed artifacts", async () => {
    expect(h3AutonomousCases, "one autonomous case per frozen h3 category").toHaveLength(2);
    expect(h3AutonomousCases.map((entry) => entry.snapshot.category), "coding and work categories").toEqual(["coding", "work"]);
    expect(
      h3AutonomousCases.every((entry) => entry.snapshot.authoringStatus === "candidate"),
      "every case remains a candidate",
    ).toBe(true);
    expect(h3AutonomousCases.every((entry) => entry.definition.autonomous), "every definition is autonomous").toBe(true);
    expect(
      h3AutonomousCases.every((entry) => (
        entry.definition.threads.length === 1 && entry.definition.threads[0]!.prompts.length === 1
      )),
      "exactly one concise prompt per case",
    ).toBe(true);
    expect(
      JSON.stringify(h3AutonomousCases.map((entry) => entry.catalogSnapshot)),
      "catalog snapshots never expose sealed paths",
    ).not.toContain("sealedPath");

    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    for (const entry of h3AutonomousCases) {
      const reference = entry.snapshot.artifacts.reference;
      const contents = await readFile(resolve(repositoryRoot, reference.sealedPath));
      expect(
        `sha256:${createHash("sha256").update(contents).digest("hex")}`,
        `${entry.snapshot.id}: sealed reference digest matches the checked-in artifact`,
      ).toBe(reference.contentDigest);
      expect(
        entry.snapshot.artifacts.verifier.contentDigest,
        `${entry.snapshot.id}: verifier digest matches the checked-in verifier`,
      ).toBe(h3VerifierDigest());
    }
  });
});

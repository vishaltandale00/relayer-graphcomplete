import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadJudgeScreenshotArtifact } from "../desktop/eval-main/judge-screenshot-loader.mjs";

const directories = [];
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("relayer-eval-test-tile"),
]);

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("judge screenshot artifact loader", () => {
  it("returns only declared, digest-verified PNG tiles for the exact execution and judge result", async () => {
    const fixture = await createFixture();

    const loaded = await loadJudgeScreenshotArtifact({
      stateFile: fixture.stateFile,
      executionId: "execution-1",
      judgeResultId: "judge-1",
      screenshotId: "shot-1",
    });

    expect(loaded).toMatchObject({
      screenshotId: "shot-1",
      metadata: { executionId: "execution-1", tileCount: 1 },
      tiles: [{
        index: 0,
        contentDigest: `sha256:${createHash("sha256").update(png).digest("hex")}`,
        dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      }],
    });
  });

  it("rejects invalid execution, judge-result, and undeclared screenshot identities", async () => {
    const fixture = await createFixture();
    const request = { stateFile: fixture.stateFile, executionId: "execution-1", judgeResultId: "judge-1", screenshotId: "shot-1" };

    await expect(loadJudgeScreenshotArtifact({ ...request, executionId: "execution-other" }))
      .rejects.toThrow("Unknown or ambiguous Eval execution");
    await expect(loadJudgeScreenshotArtifact({ ...request, judgeResultId: "judge-other" }))
      .rejects.toThrow("Unknown or ambiguous judge result");
    await expect(loadJudgeScreenshotArtifact({ ...request, screenshotId: "shot-other" }))
      .rejects.toThrow("Screenshot is not declared");
  });

  it("rejects artifact paths outside the selected local run root", async () => {
    const fixture = await createFixture({ artifactDirectory: join(tmpdir(), "outside-eval-run") });

    await expect(loadJudgeScreenshotArtifact({
      stateFile: fixture.stateFile,
      executionId: "execution-1",
      judgeResultId: "judge-1",
      screenshotId: "shot-1",
    })).rejects.toThrow("Judge artifact directory escapes its authorized root");
  });

  it("rejects symbolic links, non-PNG tiles, and immutable digest mismatches", async () => {
    const linked = await createFixture();
    const actualTile = join(linked.screenshotDirectory, "actual.png");
    await writeFile(actualTile, png);
    await rm(linked.tilePath);
    await symlink(actualTile, linked.tilePath);
    await expect(loadFixture(linked)).rejects.toThrow("must not use symbolic links");

    const nonPng = await createFixture();
    await writeFile(nonPng.tilePath, "not a png");
    await expect(loadFixture(nonPng)).rejects.toThrow("is not a PNG");

    const mismatched = await createFixture();
    await writeFile(mismatched.tilePath, Buffer.concat([png, Buffer.from("changed")]));
    await expect(loadFixture(mismatched)).rejects.toThrow("digest does not match immutable metadata");
  });
});

async function loadFixture(fixture) {
  return loadJudgeScreenshotArtifact({
    stateFile: fixture.stateFile,
    executionId: "execution-1",
    judgeResultId: "judge-1",
    screenshotId: "shot-1",
  });
}

async function createFixture({ artifactDirectory } = {}) {
  const evalDataRoot = await mkdtemp(join(tmpdir(), "relayer-judge-artifact-test-"));
  directories.push(evalDataRoot);
  const runId = "run-1";
  const runRoot = join(evalDataRoot, "runs", runId);
  const resolvedArtifactDirectory = artifactDirectory || join(
    runRoot,
    "executions",
    "execution-1",
    "turns",
    "turn-1",
    "simulated-user",
  );
  const screenshotDirectory = join(resolvedArtifactDirectory, "screenshots", "shot-1");
  const tilePath = join(screenshotDirectory, "shot-1-001.png");
  const stateFile = join(evalDataRoot, "test-runs.json");
  const contentDigest = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  if (!artifactDirectory) {
    await mkdir(screenshotDirectory, { recursive: true });
    await writeFile(tilePath, png);
    await writeFile(join(screenshotDirectory, "metadata.json"), JSON.stringify({
      schemaVersion: 1,
      screenshotId: "shot-1",
      executionId: "execution-1",
      tileCount: 1,
      tiles: [{ index: 0, width: 4, height: 3, contentDigest }],
    }));
  } else {
    await mkdir(runRoot, { recursive: true });
  }
  await writeFile(stateFile, JSON.stringify({
    schemaVersion: 1,
    runs: [{
      id: runId,
      executions: [{
        id: "execution-1",
        turns: [{
          judgeResults: [{
            id: "judge-1",
            artifactDirectory: resolvedArtifactDirectory,
            references: { screenshots: ["screenshots/shot-1/metadata.json"] },
          }],
        }],
      }],
    }],
  }));
  return { stateFile, screenshotDirectory, tilePath };
}

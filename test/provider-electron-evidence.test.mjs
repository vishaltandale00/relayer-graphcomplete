import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ffmpeg = "/opt/homebrew/bin/ffmpeg";
const ffprobe = "/opt/homebrew/bin/ffprobe";
const mediaToolsAvailable = [chrome, ffmpeg, ffprobe].every(existsSync);
const evidenceDirectory = new URL("../docs/evidence/issue-157-provider-ux/", import.meta.url);

function pngDimensions(bytes) {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("provider browser evidence", () => {
  it("locks every committed evidence artifact and script to the manifest", async () => {
    const manifest = JSON.parse(await readFile(new URL("manifest.json", evidenceDirectory), "utf8"));
    expect(manifest).toMatchObject({ schemaVersion: 1, inference: false, viewport: { width: 1280, height: 800 } });
    expect(manifest.activeAdapters).toEqual([
      "codex-subscription", "claude-subscription", "openai-api", "anthropic-api", "openrouter", "vercel-ai-router",
    ]);
    expect(Object.keys(manifest.scenes)).toEqual([
      "onboarding", "endpoint", "family", "providers", "families", "harnesses", "recovery",
    ]);
    expect(Object.keys(manifest.variants)).toEqual([
      "light", "narrow", "long-label", "loading", "invalid", "error", "unavailable", "stale", "removed", "no-compatible", "authorization",
    ]);
    expect(manifest.recording).toMatchObject({
      kind: "cdp-interaction-frames",
      captureFps: 6,
      frameWidth: 1280,
      frameHeight: 800,
      interactions: ["click", "type", "validate", "save", "logout", "refresh", "select", "retry"],
      mockedBoundaries: ["provider registry", "provider authentication", "model catalog", "product API", "retry execution"],
    });
    expect(manifest.recording.frameCount).toBeGreaterThanOrEqual(60);

    for (const entry of [...Object.values(manifest.scenes), ...Object.values(manifest.variants), manifest.poster, manifest.video]) {
      const bytes = await readFile(new URL(entry.file, evidenceDirectory));
      expect(bytes.byteLength, entry.file).toBe(entry.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), entry.file).toBe(entry.sha256);
      if (entry.file.endsWith(".png")) expect(pngDimensions(bytes), entry.file).toEqual({ width: entry.width, height: entry.height });
    }

    const motionFiles = (await readdir(new URL("motion/", evidenceDirectory)))
      .filter((name) => name.endsWith(".png"))
      .sort();
    expect(motionFiles).toHaveLength(manifest.recording.frameCount);
    const motionHash = createHash("sha256");
    let motionBytes = 0;
    for (const file of motionFiles) {
      const bytes = await readFile(new URL(`motion/${file}`, evidenceDirectory));
      expect(pngDimensions(bytes), file).toEqual({ width: 1280, height: 800 });
      motionHash.update(bytes);
      motionBytes += bytes.byteLength;
    }
    expect(motionBytes).toBe(manifest.recording.frameBytes);
    expect(motionHash.digest("hex")).toBe(manifest.recording.framesSha256);

    // The capture flow below needs macOS media tools and skips elsewhere, but
    // these parse checkpoints run on every CI platform and catch syntax or
    // import regressions in the evidence scripts.
    for (const script of [
      "scripts/capture-provider-ux-video.mjs",
      "scripts/provider-ux-evidence-browser.mjs",
    ]) {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--check"],
        { input: readFileSync(new URL(`../${script}`, import.meta.url)), encoding: "utf8" },
      );
      expect(result.status, `${script} stays parseable: ${result.stderr.trim()}`).toBe(0);
    }
  }, 15_000);

  it.skipIf(!mediaToolsAvailable)("renders the actual desktop UI against fake APIs and encodes deterministic video evidence", async () => {
    const output = await mkdtemp(join(tmpdir(), "relayer-provider-video-test-"));
    try {
      const { stdout } = await run(process.execPath, [
        "scripts/capture-provider-ux-video.mjs",
        "--output-dir",
        output,
      ], {
        cwd: new URL("..", import.meta.url),
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 8,
      });
      const result = JSON.parse(stdout.trim());
      expect(result.scenes).toEqual([
        "onboarding",
        "endpoint",
        "family",
        "alternate-harness",
        "providers",
        "families",
        "harnesses",
        "recovery",
      ]);

      const frames = (await readdir(join(output, "frames")))
        .filter((name) => name.endsWith(".png"))
        .sort();
      expect(frames).toHaveLength(8);
      for (const frame of frames) {
        const bytes = await readFile(join(output, "frames", frame));
        expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(bytes.byteLength).toBeGreaterThan(20_000);
      }

      const variants = (await readdir(join(output, "variants")))
        .filter((name) => name.endsWith(".png"))
        .sort();
      expect(variants).toEqual([
        "authorization.png", "error.png", "invalid.png", "light.png", "loading.png", "long-label.png", "narrow.png", "no-compatible.png", "removed.png", "stale.png", "unavailable.png",
      ]);
      expect(existsSync(join(output, "manifest.json"))).toBe(true);
      expect(existsSync(join(output, "provider-ux-poster.png"))).toBe(true);
      const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
      const motion = (await readdir(join(output, "motion"))).filter((name) => name.endsWith(".png")).sort();
      expect(motion).toHaveLength(manifest.recording.frameCount);
      expect(manifest.recording).toMatchObject({
        kind: "cdp-interaction-frames",
        captureFps: 6,
        frameWidth: 1280,
        frameHeight: 800,
      });
      expect(manifest.recording.frameCount).toBeGreaterThanOrEqual(60);

      const video = join(output, "provider-ux-demo.mp4");
      expect((await stat(video)).size).toBeGreaterThan(100_000);
      const { stdout: metadata } = await run(ffprobe, [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,codec_name:format=duration",
        "-of", "json",
        video,
      ]);
      const parsed = JSON.parse(metadata);
      expect(parsed.streams[0]).toMatchObject({ width: 1280, height: 800, codec_name: "h264" });
      expect(Number(parsed.format.duration)).toBeGreaterThan(16);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 120_000);
});

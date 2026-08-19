import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evalHarnessConfigurationPaths } from "../desktop/eval-main/configuration-paths.mjs";

const names = (paths) => paths.map((path) => basename(path));

describe("Eval harness configuration availability", () => {
  it("includes Prime configurations when the development package is available", () => {
    const packageAvailable = vi.fn(() => true);

    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: false,
      packageAvailable,
    }))).toEqual([
      "fixture-task-system.yaml",
      "codex-basic.yaml",
      "codex-basic-high.yaml",
      "prime-agent-basic.yaml",
      "prime-agent-deep.yaml",
    ]);
    expect(packageAvailable).toHaveBeenCalledWith("@earendil-works/pi-coding-agent");
  });

  it("hides Prime configurations when the development package is unavailable", () => {
    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: false,
      packageAvailable: () => false,
    }))).toEqual([
      "fixture-task-system.yaml",
      "codex-basic.yaml",
      "codex-basic-high.yaml",
    ]);
  });

  it("never exposes development-only Prime configurations in packaged Eval", () => {
    const packageAvailable = vi.fn(() => true);

    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: true,
      packageAvailable,
    }))).toEqual([
      "fixture-task-system.yaml",
      "codex-basic.yaml",
      "codex-basic-high.yaml",
    ]);
    expect(packageAvailable).not.toHaveBeenCalled();
  });
});

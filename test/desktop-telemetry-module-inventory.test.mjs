import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { APPROVED_TELEMETRY_MODULES } from "../desktop/shared/telemetry-module-inventory.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function filesBelow(root, extension) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push(relative(repositoryRoot, path).replaceAll("\\", "/"));
      }
    }
  }
  await visit(resolve(repositoryRoot, root));
  return files.sort();
}

describe("sealed telemetry module inventory", () => {
  it("matches every packaged application module and excludes tests and arbitrary names", async () => {
    const renderer = await filesBelow("desktop/renderer/src", ".js");
    renderer.push("desktop/renderer/theme-bootstrap.js");
    renderer.sort();

    expect(APPROVED_TELEMETRY_MODULES.renderer).toEqual(renderer);
    expect(APPROVED_TELEMETRY_MODULES["electron-main"]).toEqual(
      await filesBelow("desktop/main", ".mjs"),
    );
    expect(APPROVED_TELEMETRY_MODULES["node-harness-host"]).toEqual(
      await filesBelow("packages/harness-host/dist", ".js"),
    );
    expect(APPROVED_TELEMETRY_MODULES["rust-app-server"]).toEqual(
      await filesBelow("crates/relayer-app-server/src", ".rs"),
    );
    expect(APPROVED_TELEMETRY_MODULES["rust-graph-server"]).toEqual(
      await filesBelow("crates/relayer-graph-server/src", ".rs"),
    );
    expect(JSON.stringify(APPROVED_TELEMETRY_MODULES)).not.toContain("privacy-sentinel");
  });
});

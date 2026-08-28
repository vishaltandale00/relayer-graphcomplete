import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const verifier = join(root, "scripts/verify-ladybug-native-receipts.mjs");
const inventoryPath = join(root, "vendor/ladybug/native-inventory.json");

const temporaryDirectories = [];

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function fixtureInventory() {
  const directory = temporaryDirectory("ladybug-native-receipt-");
  const inventory = join(directory, "native-inventory.json");
  cpSync(inventoryPath, inventory);
  return { directory, inventory };
}

describe("Ladybug native dependency receipts", () => {
  it("verifies the frozen inventory and rejects it as release-ready while the binding license is missing", () => {
    expect(execFileSync(process.execPath, [verifier], { encoding: "utf8" })).toContain("release blockers preserved");
    const release = spawnSync(process.execPath, [verifier, "--release-ready"], { encoding: "utf8" });
    expect(release.status).not.toBe(0);
    expect(release.stderr).toContain("native receipt is not release-ready");
  });

  it("fails closed when a compiled native component loses its notice", () => {
    const { inventory } = fixtureInventory();
    const receipt = JSON.parse(readFileSync(inventory, "utf8"));
    receipt.nativeComponents.find(({ name }) => name === "zstd").licensePath = null;
    writeFileSync(inventory, `${JSON.stringify(receipt, null, 2)}\n`);
    const result = spawnSync(process.execPath, [verifier, "--inventory", inventory], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("zstd has no license notice");
  });

  it("fails closed when the exact source contains an unlisted native subtree", () => {
    const source = temporaryDirectory("ladybug-native-source-");
    mkdirSync(join(source, "src"), { recursive: true });
    mkdirSync(join(source, "lbug-src", "third_party", "surprise-native"), { recursive: true });
    const result = spawnSync(process.execPath, [verifier, "--source-root", source], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unlisted native subtree");
  });

  it("replays the vendored OpenSSL notice against exact source bytes", () => {
    const source = temporaryDirectory("openssl-license-source-");
    cpSync(join(root, "vendor/ladybug/notices/openssl-LICENSE.txt"), join(source, "LICENSE.txt"));
    expect(execFileSync(process.execPath, [verifier, "--openssl-source-root", source], { encoding: "utf8" }))
      .toContain("release blockers preserved");
    writeFileSync(join(source, "LICENSE.txt"), "not OpenSSL 3.5.8\n");
    const result = spawnSync(process.execPath, [verifier, "--openssl-source-root", source], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OpenSSL source license changed");
  });
});

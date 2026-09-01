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
  it("verifies the frozen inventory and accepts it as release-ready under the vendored upstream license", () => {
    expect(execFileSync(process.execPath, [verifier], { encoding: "utf8" })).toContain("no release blockers declared");
    const release = spawnSync(process.execPath, [verifier, "--release-ready"], { encoding: "utf8" });
    expect(release.status).toBe(0);
    expect(release.stdout).toContain("no release blockers declared");
  });

  it("fails closed when the native inventory re-declares a release blocker", () => {
    const { inventory } = fixtureInventory();
    const receipt = JSON.parse(readFileSync(inventory, "utf8"));
    receipt.releaseBlockers = ["lbug-binding-missing-upstream-license-file"];
    writeFileSync(inventory, `${JSON.stringify(receipt, null, 2)}\n`);
    const result = spawnSync(process.execPath, [verifier, "--inventory", inventory, "--release-ready"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("native receipt is not release-ready");
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

  // The `licensePaths` set must include the binding notice so dropping its
  // digest entry breaks the notice-set/digest-map alignment. This observes the
  // structural fix directly; a nulled `binding.licensePath` is instead caught
  // by the frozen binding snapshot above and needs no separate case.
  it("fails closed when the binding notice digest is dropped from the notice map", () => {
    const { inventory } = fixtureInventory();
    const receipt = JSON.parse(readFileSync(inventory, "utf8"));
    delete receipt.noticeSha256["vendor/ladybug/notices/ladybug-binding-LICENSE"];
    writeFileSync(inventory, `${JSON.stringify(receipt, null, 2)}\n`);
    const result = spawnSync(process.execPath, [verifier, "--inventory", inventory], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("every license notice path must have exactly one digest entry");
  });

  it("reports preserved blockers in plain mode instead of a false no-blockers claim", () => {
    const { inventory } = fixtureInventory();
    const receipt = JSON.parse(readFileSync(inventory, "utf8"));
    receipt.releaseBlockers = ["lbug-binding-missing-upstream-license-file"];
    writeFileSync(inventory, `${JSON.stringify(receipt, null, 2)}\n`);
    const result = spawnSync(process.execPath, [verifier, "--inventory", inventory], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release blockers preserved: lbug-binding-missing-upstream-license-file");
    expect(result.stdout).not.toContain("no release blockers declared");
  });

  it("fails closed when an unlisted file appears in the notices directory", () => {
    const stray = join(root, "vendor/ladybug/notices", "stray-editor-backup~");
    writeFileSync(stray, "stray\n");
    try {
      const result = spawnSync(process.execPath, [verifier], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("notices directory must contain exactly the inventoried files");
    } finally {
      rmSync(stray, { force: true });
    }
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
      .toContain("no release blockers declared");
    writeFileSync(join(source, "LICENSE.txt"), "not OpenSSL 3.5.8\n");
    const result = spawnSync(process.execPath, [verifier, "--openssl-source-root", source], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OpenSSL source license changed");
  });
});

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
  it("verifies the frozen inventory and fails closed on every receipt, source, and OpenSSL mutation", () => {
    expect(execFileSync(process.execPath, [verifier], { encoding: "utf8" }), "frozen inventory verdict")
      .toContain("release blockers preserved");
    const release = spawnSync(process.execPath, [verifier, "--release-ready"], { encoding: "utf8" });
    expect(release.status, "release-ready exit status while the binding license is missing").not.toBe(0);
    expect(release.stderr, "release blocker reason").toContain("native receipt is not release-ready");

    const { inventory } = fixtureInventory();
    const receipt = JSON.parse(readFileSync(inventory, "utf8"));
    receipt.nativeComponents.find(({ name }) => name === "zstd").licensePath = null;
    writeFileSync(inventory, `${JSON.stringify(receipt, null, 2)}\n`);
    const noticeless = spawnSync(process.execPath, [verifier, "--inventory", inventory], { encoding: "utf8" });
    expect(noticeless.status, "exit status for a compiled component without its notice").not.toBe(0);
    expect(noticeless.stderr, "noticeless component named").toContain("zstd has no license notice");

    const source = temporaryDirectory("ladybug-native-source-");
    mkdirSync(join(source, "src"), { recursive: true });
    mkdirSync(join(source, "lbug-src", "third_party", "surprise-native"), { recursive: true });
    const unlisted = spawnSync(process.execPath, [verifier, "--source-root", source], { encoding: "utf8" });
    expect(unlisted.status, "exit status for an unlisted native subtree").not.toBe(0);
    expect(unlisted.stderr, "unlisted subtree named").toContain("unlisted native subtree");

    const opensslSource = temporaryDirectory("openssl-license-source-");
    cpSync(join(root, "vendor/ladybug/notices/openssl-LICENSE.txt"), join(opensslSource, "LICENSE.txt"));
    expect(
      execFileSync(process.execPath, [verifier, "--openssl-source-root", opensslSource], { encoding: "utf8" }),
      "vendored OpenSSL notice replayed against exact source bytes",
    ).toContain("release blockers preserved");
    writeFileSync(join(opensslSource, "LICENSE.txt"), "not OpenSSL 3.5.8\n");
    const mutatedOpenSSL = spawnSync(process.execPath, [verifier, "--openssl-source-root", opensslSource], { encoding: "utf8" });
    expect(mutatedOpenSSL.status, "exit status for a changed OpenSSL source license").not.toBe(0);
    expect(mutatedOpenSSL.stderr, "OpenSSL drift named").toContain("OpenSSL source license changed");
  });
});

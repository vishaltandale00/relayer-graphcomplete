import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(
  repositoryRoot,
  "docs/evidence/issue-303-ladybug-index-latency/receipt.json",
);

if (platform() !== "darwin" || arch() !== "arm64") {
  throw new Error("the qualifying Ladybug latency capture requires macOS Apple Silicon");
}
const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
  cwd: repositoryRoot,
});
if (status.trim() !== "") {
  throw new Error("commit the implementation before capturing its latency receipt");
}
const { stdout: revision } = await execFileAsync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
});
await mkdir(dirname(output), { recursive: true });
const child = await execFileAsync(
  "cargo",
  [
    "bench",
    "--locked",
    "-p",
    "relayer-graph-server",
    "--bench",
    "ladybug_index_save_latency",
    "--",
    "--warmups",
    "10",
    "--samples",
    "200",
    "--source-commit",
    revision.trim(),
    "--output",
    output,
  ],
  { cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
);
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);

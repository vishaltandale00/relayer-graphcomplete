import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function inspectFolder(path) {
  try {
    const { stdout } = await execute("git", ["-C", path, "rev-parse", "--show-toplevel"]);
    const repositoryRoot = stdout.trim();
    const branch = await execute("git", ["-C", repositoryRoot, "branch", "--show-current"])
      .then(({ stdout: value }) => value.trim())
      .catch(() => "");
    return { path, git: true, repositoryRoot, branch: branch || "detached" };
  } catch {
    return { path, git: false };
  }
}

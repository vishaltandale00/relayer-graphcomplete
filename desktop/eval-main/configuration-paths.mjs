import { join } from "node:path";

const primeAgentPackage = "@earendil-works/pi-coding-agent";

export function evalHarnessConfigurationPaths({
  harnessDirectory,
  isPackaged,
  packageAvailable = defaultPackageAvailable,
}) {
  const paths = [
    join(harnessDirectory, "fixture-task-system.yaml"),
    join(harnessDirectory, "codex-basic.yaml"),
    join(harnessDirectory, "codex-basic-high.yaml"),
    join(harnessDirectory, "codex-layered-navigation-luna.yaml"),
    join(harnessDirectory, "codex-multi-agent-layered-navigation.yaml"),
    join(harnessDirectory, "claude-basic.yaml"),
  ];
  if (!isPackaged && packageAvailable(primeAgentPackage)) {
    paths.push(
      join(harnessDirectory, "prime-agent-basic.yaml"),
      join(harnessDirectory, "prime-agent-deep.yaml"),
      join(harnessDirectory, "prime-agent-layered-navigation-luna.yaml"),
    );
  }
  return paths;
}

function defaultPackageAvailable(packageName) {
  try {
    import.meta.resolve(packageName);
    return true;
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return false;
    throw error;
  }
}

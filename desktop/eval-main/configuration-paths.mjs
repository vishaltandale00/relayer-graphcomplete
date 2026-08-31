import { join } from "node:path";

import { desktopTarget, desktopTargetFromEnvironment } from "../shared/target.mjs";

const primeAgentPackage = "@earendil-works/pi-coding-agent";
export const GRAPH_SEARCH_EVAL_TARGET = "macos-arm64";

export function evalRuntimeTarget({
  isPackaged,
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
}) {
  return isPackaged
    ? desktopTarget({ platform, architecture })
    : desktopTargetFromEnvironment(environment);
}

export function evalHarnessConfigurationPaths({
  harnessDirectory,
  isPackaged,
  packageAvailable = defaultPackageAvailable,
  targetKey,
}) {
  const graphSearchQualified = targetKey === GRAPH_SEARCH_EVAL_TARGET;
  const paths = [
    join(harnessDirectory, "fixture-task-system.yaml"),
    ...(graphSearchQualified ? [join(harnessDirectory, "fixture-graph-memory.yaml")] : []),
    join(harnessDirectory, "codex-basic.yaml"),
    ...(graphSearchQualified ? [join(harnessDirectory, "codex-basic-graph-search.yaml")] : []),
    join(harnessDirectory, "codex-basic-high.yaml"),
    join(harnessDirectory, "codex-eval-complete-disabled.yaml"),
    join(harnessDirectory, "codex-eval-complete-enabled.yaml"),
    ...(graphSearchQualified ? [
      join(harnessDirectory, "codex-eval-lantern-search-disabled-recursion-disabled.yaml"),
      join(harnessDirectory, "codex-eval-lantern-search-query-v1-recursion-disabled.yaml"),
      join(harnessDirectory, "codex-eval-lantern-search-disabled-recursion-enabled.yaml"),
      join(harnessDirectory, "codex-eval-lantern-search-query-v1-recursion-enabled.yaml"),
    ] : []),
    join(harnessDirectory, "codex-layered-navigation-luna.yaml"),
    join(harnessDirectory, "codex-multi-agent-layered-navigation.yaml"),
    join(harnessDirectory, "claude-basic.yaml"),
    ...(graphSearchQualified ? [join(harnessDirectory, "claude-basic-graph-search.yaml")] : []),
    join(harnessDirectory, "codex-layered-personal-presentation-v0.yaml"),
    join(harnessDirectory, "codex-layered-personal-presentation-v1.yaml"),
  ];
  if (!isPackaged && packageAvailable(primeAgentPackage)) {
    paths.push(
      join(harnessDirectory, "prime-agent-basic.yaml"),
      ...(graphSearchQualified ? [join(harnessDirectory, "prime-agent-basic-graph-search.yaml")] : []),
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

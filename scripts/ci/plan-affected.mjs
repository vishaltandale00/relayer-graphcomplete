#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const allChapterNames = [
  "rust",
  "typescript",
  "vitest",
  "python",
  "receipts",
  "prd",
  "packaging",
];

function parseArguments(argv) {
  const options = { changedFiles: [], mode: "affected" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--changed-file") {
      options.changedFiles.push(value);
      index += 1;
    } else if (argument === "--repository") {
      options.repository = value;
      index += 1;
    } else if (argument === "--base") {
      options.base = value;
      index += 1;
    } else if (argument === "--head") {
      options.head = value;
      index += 1;
    } else if (argument === "--mode") {
      options.mode = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  if (!new Set(["affected", "full"]).has(options.mode)) {
    throw new Error(`Unsupported planning mode: ${options.mode}`);
  }
  return options;
}

function normalizedRepositoryPath(repository, path) {
  const normalized = path.split(sep).join("/").replace(/^\.\//, "");
  if (
    normalized.startsWith("../") ||
    resolve(repository, normalized) === resolve(repository)
  ) {
    throw new Error(`Changed path is outside the repository: ${path}`);
  }
  return normalized;
}

function changedFilesFromGit(repository, base, head) {
  if (!base || !head) {
    throw new Error(
      "Provide --base and --head when --changed-file is not used",
    );
  }
  const fields = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`],
    {
      cwd: repository,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    index += 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      paths.push(fields[index], fields[index + 1]);
      index += 2;
    } else {
      paths.push(fields[index]);
      index += 1;
    }
  }
  return paths;
}

function localRustGraph(repository) {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--format-version", "1", "--no-deps"],
      {
        cwd: repository,
        encoding: "utf8",
      },
    ),
  );
  const workspaceIds = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter((candidate) =>
    workspaceIds.has(candidate.id),
  );
  const names = new Set(packages.map((candidate) => candidate.name));
  return new Map(
    packages.map((candidate) => [
      candidate.name,
      new Set(
        candidate.dependencies
          .filter((dependency) => dependency.path && names.has(dependency.name))
          .map((dependency) => dependency.name),
      ),
    ]),
  );
}

function localNpmGraph(repository) {
  const rootManifest = JSON.parse(
    readFileSync(join(repository, "package.json"), "utf8"),
  );
  const manifestPaths = ["desktop/package.json"];
  for (const workspacePattern of rootManifest.workspaces ?? []) {
    if (workspacePattern === "packages/*") {
      for (const name of ["eval-runner", "graph-client", "harness-host"]) {
        manifestPaths.push(`packages/${name}/package.json`);
      }
    }
  }
  const manifests = manifestPaths.map((path) =>
    JSON.parse(readFileSync(join(repository, path), "utf8")),
  );
  const names = new Set(manifests.map((manifest) => manifest.name));
  return new Map(
    manifests.map((manifest) => {
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      };
      return [
        manifest.name,
        new Set(Object.keys(dependencies).filter((name) => names.has(name))),
      ];
    }),
  );
}

function reverseClosure(graph, roots) {
  const selected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [candidate, dependencies] of graph) {
      if (
        !selected.has(candidate) &&
        [...dependencies].some((dependency) => selected.has(dependency))
      ) {
        selected.add(candidate);
        changed = true;
      }
    }
  }
  return [...selected].sort();
}

function dependencyClosure(graph, roots) {
  const selected = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const candidate = pending.pop();
    for (const dependency of graph.get(candidate) ?? []) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return [...selected].sort();
}

function matches(path, rule) {
  return (
    (rule.exact && path === rule.exact) ||
    (rule.prefix && path.startsWith(rule.prefix))
  );
}

function allTrueChapters() {
  return Object.fromEntries(allChapterNames.map((chapter) => [chapter, true]));
}

function fullPlan(repository, config, changedFiles, reasons) {
  const npmWorkspaces = [...localNpmGraph(repository).keys()].sort();
  return {
    version: config.version,
    mode: "full",
    reasons,
    changedPaths: changedFiles,
    rustPackages: [...localRustGraph(repository).keys()].sort(),
    npmWorkspaces,
    npmBuildWorkspaces: npmWorkspaces,
    vitestFiles: [],
    vitestRustPackages: [...config.vitestRustRuntime.fullPortfolio].sort(),
    runtimeRustPackages: [...config.vitestRustRuntime.fullPortfolio].sort(),
    rustCrash: true,
    rootTypeScript: true,
    chapters: allTrueChapters(),
  };
}

function buildPlan(repository, config, changedFiles, forcedMode) {
  if (forcedMode === "full") {
    return fullPlan(repository, config, changedFiles, [
      "Full verification required by workflow mode",
    ]);
  }

  const chapters = Object.fromEntries(
    allChapterNames.map((chapter) => [chapter, false]),
  );
  const rustRoots = new Set();
  const npmRoots = new Set();
  const reasons = [];
  const vitestFiles = new Set();
  let rootTypeScript = false;

  for (const path of changedFiles) {
    if (
      /^test\/.*\.(test|spec)\.[cm]?[jt]sx?$/.test(path) &&
      !existsSync(join(repository, path))
    ) {
      reasons.push(`${path}: deleted test path`);
      continue;
    }
    if (
      config.fullPortfolio.exact.includes(path) ||
      config.fullPortfolio.prefixes.some((prefix) => path.startsWith(prefix))
    ) {
      reasons.push(`${path}: full-portfolio input`);
      continue;
    }

    let mapped = false;
    for (const owner of config.rustOwners) {
      if (path.startsWith(owner.prefix)) {
        rustRoots.add(owner.package);
        chapters.rust = true;
        for (const testPath of owner.vitestFiles ?? [])
          vitestFiles.add(testPath);
        for (const testPath of config.sourceVitestPortfolio)
          vitestFiles.add(testPath);
        mapped = true;
      }
    }
    for (const owner of config.npmOwners) {
      if (path.startsWith(owner.prefix)) {
        npmRoots.add(owner.package);
        chapters.typescript = true;
        chapters.packaging ||= owner.packaging === true;
        rootTypeScript ||= owner.package === "relayer-desktop";
        for (const testPath of owner.vitestFiles ?? [])
          vitestFiles.add(testPath);
        for (const testPath of config.sourceVitestPortfolio)
          vitestFiles.add(testPath);
        mapped = true;
      }
    }
    for (const owner of [...config.chapterOwners, ...config.scriptOwners]) {
      if (matches(path, owner)) {
        for (const chapter of owner.chapters) chapters[chapter] = true;
        rootTypeScript ||= owner.rootTypeScript === true;
        for (const testPath of owner.vitestFiles ?? [])
          vitestFiles.add(testPath);
        if (owner.fullVitestPortfolio) {
          for (const testPath of config.sourceVitestPortfolio)
            vitestFiles.add(testPath);
        }
        if (owner.changedTestFile) {
          vitestFiles.add(
            /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ? path : "test",
          );
        }
        mapped = true;
      }
    }
    if (!mapped) reasons.push(`${path}: unmapped path`);
  }

  if (reasons.length > 0 || changedFiles.length === 0) {
    if (changedFiles.length === 0)
      reasons.push("No changed paths were available");
    return fullPlan(repository, config, changedFiles, reasons);
  }

  if (rustRoots.size > 0) {
    for (const chapter of config.crossModuleChapters.rust)
      chapters[chapter] = true;
  }
  if (npmRoots.size > 0) {
    for (const chapter of config.crossModuleChapters.npm)
      chapters[chapter] = true;
  }
  if (chapters.vitest && vitestFiles.size === 0) {
    return fullPlan(repository, config, changedFiles, [
      `${changedFiles.join(", ")}: no mapped Vitest checkpoint`,
    ]);
  }

  const npmGraph = localNpmGraph(repository);
  const npmWorkspaces = reverseClosure(npmGraph, npmRoots);
  const buildRoots = new Set(npmWorkspaces);
  if (chapters.vitest) {
    for (const workspace of config.vitestPrerequisiteWorkspaces)
      buildRoots.add(workspace);
  }
  const vitestRustPackages = new Set();
  if (vitestFiles.has("test")) {
    for (const packageName of config.vitestRustRuntime.fullPortfolio)
      vitestRustPackages.add(packageName);
  }
  for (const runtime of config.vitestRustRuntime.files) {
    if (vitestFiles.has(runtime.exact)) {
      for (const packageName of runtime.packages)
        vitestRustPackages.add(packageName);
    }
  }

  const rustGraph = localRustGraph(repository);
  const rustPackages = dependencyClosure(
    rustGraph,
    reverseClosure(rustGraph, rustRoots),
  );
  const runtimeRustPackages = new Set(vitestRustPackages);
  for (const packageName of rustPackages) {
    if (config.vitestRustRuntime.fullPortfolio.includes(packageName))
      runtimeRustPackages.add(packageName);
  }

  return {
    version: config.version,
    mode: "affected",
    reasons: changedFiles.map((path) => `${path}: mapped`),
    changedPaths: changedFiles,
    rustPackages,
    npmWorkspaces,
    npmBuildWorkspaces: dependencyClosure(npmGraph, buildRoots),
    vitestFiles: [...vitestFiles].sort(),
    vitestRustPackages: [...vitestRustPackages].sort(),
    runtimeRustPackages: [...runtimeRustPackages].sort(),
    rustCrash: rustPackages.some((name) =>
      new Set([
        "relayer-graph-core",
        "relayer-graph-server",
        "relayer-app-server",
      ]).has(name),
    ),
    rootTypeScript,
    chapters,
  };
}

function writeActionsOutputs(plan) {
  if (!process.env.GITHUB_OUTPUT) return;
  const outputs = [
    `plan=${JSON.stringify(plan)}`,
    `mode=${plan.mode}`,
    `rust_crash=${plan.rustCrash}`,
    `rust_runtime=${plan.runtimeRustPackages.length > 0}`,
    ...Object.entries(plan.chapters).map(
      ([chapter, selected]) => `${chapter}=${selected}`,
    ),
  ];
  appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Affected-module plan v${plan.version}\n\n- Mode: **${plan.mode}**\n- Rust packages: ${plan.rustPackages.join(", ") || "none"}\n- npm workspaces: ${plan.npmWorkspaces.join(", ") || "none"}\n- Vitest files: ${plan.vitestFiles.join(", ") || (plan.mode === "full" ? "full portfolio" : "none")}\n- Reasons: ${plan.reasons.join("; ")}\n`,
    );
  }
}

const options = parseArguments(process.argv.slice(2));
const repository = resolve(
  options.repository ?? join(scriptDirectory, "..", ".."),
);
const config = JSON.parse(
  readFileSync(join(scriptDirectory, "affected-modules.v1.json"), "utf8"),
);
const rawChangedFiles =
  options.changedFiles.length > 0
    ? options.changedFiles
    : options.mode === "full"
      ? []
      : changedFilesFromGit(repository, options.base, options.head);
const changedFiles = [
  ...new Set(
    rawChangedFiles.map((path) => normalizedRepositoryPath(repository, path)),
  ),
].sort();
const plan = buildPlan(repository, config, changedFiles, options.mode);
writeActionsOutputs(plan);
process.stdout.write(`${JSON.stringify(plan)}\n`);

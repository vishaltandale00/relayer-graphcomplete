#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepository = resolve(scriptDirectory, "..", "..");

function shellCommands(script) {
  return script.split(/\s+&&\s+/).map((command) => command.trim());
}

export function validateVerificationPortfolio(repository, manifest) {
  const failures = [];
  if (manifest.version !== 1)
    failures.push(`version: expected 1, received ${manifest.version}`);

  for (const [id, command] of Object.entries(manifest.commands ?? {})) {
    if (typeof command.owner !== "string" || command.owner.length === 0) {
      failures.push(`${id}: expected exactly one CI owner`);
    }
    if (typeof command.shell !== "string" || command.shell.length === 0) {
      failures.push(`${id}: missing shell command`);
    }
  }

  const authorityChapters = new Map();
  for (const [chapterName, chapter] of Object.entries(
    manifest.chapters ?? {},
  )) {
    if (typeof chapter.job !== "string" || chapter.job.length === 0) {
      failures.push(`${chapterName}: missing workflow job owner`);
    }
    for (const role of ["authorities", "prerequisites"]) {
      if (!Array.isArray(chapter[role])) {
        failures.push(`${chapterName}: missing ${role} command list`);
        continue;
      }
      for (const id of chapter[role]) {
        if (!manifest.commands?.[id]) {
          failures.push(`${chapterName}: unknown ${role} command ${id}`);
        }
      }
    }
    for (const id of chapter.authorities ?? []) {
      const chapters = authorityChapters.get(id) ?? [];
      chapters.push(chapterName);
      authorityChapters.set(id, chapters);
      if (manifest.commands?.[id]?.owner !== chapter.job) {
        failures.push(
          `${id}: declared owner ${manifest.commands?.[id]?.owner ?? "missing"} does not match ${chapterName} job ${chapter.job}`,
        );
      }
    }
  }
  for (const id of Object.keys(manifest.commands ?? {})) {
    const chapters = authorityChapters.get(id) ?? [];
    if (chapters.length !== 1) {
      failures.push(
        `${id}: expected one authoritative chapter, received ${chapters.length}`,
      );
    }
  }

  const packageScripts = JSON.parse(
    readFileSync(join(repository, "package.json"), "utf8"),
  ).scripts;
  for (const scriptName of ["check", "build"]) {
    const commandIds = manifest.scripts?.[scriptName] ?? [];
    const missingIds = commandIds.filter((id) => !manifest.commands?.[id]);
    for (const id of missingIds)
      failures.push(`${scriptName}: unknown command ${id}`);
    const actual = shellCommands(packageScripts[scriptName]);
    const declared = commandIds
      .map((id) => manifest.commands?.[id]?.shell)
      .filter(Boolean);
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      failures.push(
        `${scriptName}: manifest commands do not match package.json order`,
      );
    }
    const hookId = manifest.lifecycleHooks?.[scriptName];
    const hook = manifest.commands?.[hookId];
    if (!hook || hook.shell !== packageScripts[`pre${scriptName}`]) {
      failures.push(
        `pre${scriptName}: manifest lifecycle hook does not match package.json`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

function main() {
  const repository = resolve(process.argv[2] ?? defaultRepository);
  const manifest = JSON.parse(
    readFileSync(
      join(repository, "scripts", "ci", "verification-portfolio.v1.json"),
      "utf8",
    ),
  );
  const result = validateVerificationPortfolio(repository, manifest);
  if (!result.ok) {
    process.stderr.write(`${result.failures.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "Verification portfolio owns every required check and build command exactly once.\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();

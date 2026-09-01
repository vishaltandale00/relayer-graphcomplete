#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [label, command, ...args] = process.argv.slice(2);
if (!label || !command) throw new Error("Usage: run-timed.mjs <label> <command> [args...]");

const startedAt = Date.now();
const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
const outcome = result.status === 0 ? "passed" : "failed";
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${label}: **${outcome}** in ${elapsedSeconds}s\n`);
  if (result.status !== 0) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- First actionable failure: **${label}**\n`);
  }
}
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;

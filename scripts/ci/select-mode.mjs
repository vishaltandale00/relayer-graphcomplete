#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export function selectCiMode({ eventName, headRef = "" }) {
  if (eventName !== "pull_request") return "full";
  return headRef.startsWith("integration/") ? "full" : "affected";
}

function main() {
  const mode = selectCiMode({
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    headRef: process.env.GITHUB_HEAD_REF ?? "",
  });
  process.stdout.write(`${mode}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

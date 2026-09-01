import { rm } from "node:fs/promises";
import { resolve } from "node:path";

await Promise.all([
  rm(resolve(import.meta.dirname, "..", "dist"), { recursive: true, force: true }),
  rm(resolve(import.meta.dirname, "..", "agent-resource"), { recursive: true, force: true }),
]);

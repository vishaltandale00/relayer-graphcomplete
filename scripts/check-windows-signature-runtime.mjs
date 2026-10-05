#!/usr/bin/env node
// Exercise the production verifier from the workflow's pwsh -> Node context
// before cold compilation, without Azure credentials or signing any file.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { verifyWindowsSignatures } from "../desktop/release/verify-windows-app.mjs";

if (process.platform !== "win32") throw new Error("Windows signature runtime proof requires a native Windows runner.");
assert(process.env.SystemRoot, "Windows SystemRoot is required.");
const path = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const execute = promisify(execFile);
let signature;
await assert.rejects(verifyWindowsSignatures({ paths: [path], publisherName: "CN=Relayer runtime probe",
  execute: async (...args) => {
    const result = await execute(...args);
    const parsed = JSON.parse(result.stdout.trim());
    signature = Array.isArray(parsed) ? parsed[0] : parsed;
    return result;
  },
}), /Windows Authenticode verification failed/);
assert.equal(signature?.Path, path, "The production query must return the requested Windows executable.");
assert.equal(signature?.Status, "Valid", "The Windows system executable must have a valid signature.");
assert.match(signature?.Subject || "", /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/u);
assert(signature?.Thumbprint, "The Windows system executable must have a signer certificate.");
console.log(JSON.stringify({ schema: "relayer.windows-signature-runtime-probe/v1", signature,
  productionPublisherMismatchRejected: true }, null, 2));

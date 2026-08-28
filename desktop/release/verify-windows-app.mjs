import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { loadDesktopReleaseContract } from "./contract.mjs";
import { desktopReleaseArtifactNames } from "./artifacts.mjs";

const execFileAsync = promisify(execFile);

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function requireFile(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size === 0) throw new Error(`Signed Windows file is missing or empty: ${filePath}`);
}

export async function verifyWindowsSignatures({ paths, publisherName, execute = execFileAsync } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("Windows signature verification requires files.");
  if (!publisherName) throw new Error("Windows signature verification requires the sealed publisher name.");
  await Promise.all(paths.map(requireFile));
  const literalPaths = paths.map((filePath) => `'${String(filePath).replaceAll("'", "''")}'`).join(",");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$results = @(${literalPaths}) | ForEach-Object {`,
    "  $signature = Get-AuthenticodeSignature -LiteralPath $_",
    "  [PSCustomObject]@{",
    "    Path = $_",
    "    Status = [string]$signature.Status",
    "    StatusMessage = [string]$signature.StatusMessage",
    "    Subject = [string]$signature.SignerCertificate.Subject",
    "    Thumbprint = [string]$signature.SignerCertificate.Thumbprint",
    "    TimestampSubject = [string]$signature.TimeStamperCertificate.Subject",
    "  }",
    "}",
    "$results | ConvertTo-Json -Compress",
  ].join("\n");
  const { stdout } = await execute("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script),
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || "").trim());
  const results = Array.isArray(parsed) ? parsed : [parsed];
  if (results.length !== paths.length) throw new Error("Windows signature verifier returned an incomplete result set.");
  const expectedSubject = String(publisherName).trim();
  for (const result of results) {
    if (
      result.Status !== "Valid" ||
      String(result.Subject || "").trim() !== expectedSubject ||
      !String(result.Thumbprint || "").trim() ||
      !String(result.TimestampSubject || "").trim()
    ) {
      throw new Error(`Windows Authenticode verification failed for ${result.Path}: ${result.Status} ${result.StatusMessage}`);
    }
  }
  return results;
}

export function windowsApplicationExecutables(appOutDir) {
  return [
    join(appOutDir, "Relayer.exe"),
    join(appOutDir, "resources", "bin", "relayer-app-server.exe"),
    join(appOutDir, "resources", "bin", "relayer-graph-server.exe"),
  ];
}

export async function verifyWindowsApplication(appOutDir, contract, options = {}) {
  if (contract?.platform !== "win32" || contract.architecture !== "x64") {
    throw new Error("Windows application verification requires the Windows x64 release contract.");
  }
  const paths = windowsApplicationExecutables(appOutDir);
  const signatures = await verifyWindowsSignatures({ paths, publisherName: contract.publisherName, ...options });
  return { paths, signatures };
}

export async function verifyWindowsRelease({ appOutDir, distRoot, contract, execute = execFileAsync } = {}) {
  const application = await verifyWindowsApplication(appOutDir, contract, { execute });
  const names = desktopReleaseArtifactNames(contract);
  const installerPath = join(distRoot, names.installer);
  const installer = await verifyWindowsSignatures({
    paths: [installerPath],
    publisherName: contract.publisherName,
    execute,
  });
  return { application, installerPath, installer };
}

export default async function verifySignedWindowsApplication(context) {
  if (process.platform !== "win32") return;
  const desktopRoot = resolve(import.meta.dirname, "..");
  const contract = await loadDesktopReleaseContract({ desktopRoot });
  if (contract.platform !== "win32") return;
  await verifyWindowsApplication(context.appOutDir, contract);
}

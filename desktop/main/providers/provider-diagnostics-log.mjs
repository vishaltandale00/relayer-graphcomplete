import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SECRET_KEY = /(?:api[-_]?key|authorization|credential|password|secret|token|error|message)/i;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/gi;

function redact(value, key = "") {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]");
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redact(entry, entryKey)]));
  }
  return value;
}

export function createProviderDiagnosticsLog({ path, maximumBytes = 256 * 1024 }) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 256) throw new Error("maximumBytes must be at least 256.");
  let queue = Promise.resolve();
  const append = async (event) => {
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const line = `${JSON.stringify(redact({ at: new Date().toISOString(), ...event }))}\n`;
    let lines = `${existing}${line}`.split(/(?<=\n)/u).filter(Boolean);
    while (Buffer.byteLength(lines.join("")) > maximumBytes && lines.length > 1) lines.shift();
    if (Buffer.byteLength(lines.join("")) > maximumBytes) {
      lines = [`${JSON.stringify({ at: new Date().toISOString(), code: "diagnostic_entry_too_large" })}\n`];
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, lines.join(""), { mode: 0o600 });
    await rename(temporary, path);
  };
  return Object.freeze({
    write(event) {
      const operation = queue.then(() => append(event), () => append(event));
      queue = operation.catch(() => undefined);
      return operation;
    },
  });
}

export function providerDiagnosticDetails(error) {
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? error.status
    : null;
  const candidate = typeof error?.code === "string" ? error.code : "unknown";
  const code = /^[A-Za-z0-9_.-]{1,64}$/.test(candidate) ? candidate : "unknown";
  return Object.freeze({ ...(status === null ? {} : { status }), code });
}

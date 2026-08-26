import { readFile, rename, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export function createProviderDefinitionStore(path, { initialDefinitions = [] } = {}) {
  async function load() {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.definitions)) throw new Error("Provider definition store is invalid.");
      return parsed.definitions;
    } catch (error) {
      if (error?.code === "ENOENT") return structuredClone(initialDefinitions);
      throw error;
    }
  }
  async function save(definitions) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, definitions }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }
  return Object.freeze({ load, save });
}

export function createEncryptedCredentialStore({ path, encrypt, decrypt }) {
  if (typeof encrypt !== "function" || typeof decrypt !== "function") throw new Error("Credential store requires encryption functions.");
  let queue = Promise.resolve();
  async function readEntries() {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value?.schemaVersion !== 1 || typeof value.entries !== "object" || value.entries === null) {
        throw new Error("Credential store is invalid.");
      }
      return value.entries;
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  }
  async function writeEntries(entries) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, entries })}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }
  function serialize(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  }
  return Object.freeze({
    set(reference, value) { return serialize(async () => {
      const entries = await readEntries();
      entries[reference] = await encrypt(JSON.stringify(value));
      await writeEntries(entries);
    }); },
    async get(reference) {
      await queue;
      const entries = await readEntries();
      if (!(reference in entries)) return null;
      return JSON.parse(await decrypt(entries[reference]));
    },
    delete(reference) { return serialize(async () => {
      const entries = await readEntries();
      if (!(reference in entries)) return false;
      delete entries[reference];
      await writeEntries(entries);
      return true;
    }); },
    async listReferences() {
      await queue;
      return Object.freeze(Object.keys(await readEntries()));
    },
  });
}

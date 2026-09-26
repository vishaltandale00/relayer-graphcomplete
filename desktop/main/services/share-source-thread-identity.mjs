import { randomUUID } from "node:crypto";

const INSTALLATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export function createShareSourceThreadIdentity({ settings, createInstallationId = randomUUID } = {}) {
  if (typeof settings?.read !== "function" || typeof settings?.update !== "function"
    || typeof createInstallationId !== "function") {
    throw new TypeError("Share source-thread identity dependencies are invalid.");
  }
  let installationIdPromise;

  const installationId = () => {
    installationIdPromise ??= (async () => {
      const saved = await settings.read();
      if (saved.shareInstallationId !== undefined) {
        if (typeof saved.shareInstallationId !== "string" || !INSTALLATION_ID.test(saved.shareInstallationId)) {
          throw new Error("Stored share installation identity is invalid.");
        }
        return saved.shareInstallationId;
      }
      const candidate = createInstallationId();
      if (typeof candidate !== "string" || !INSTALLATION_ID.test(candidate)) {
        throw new Error("Generated share installation identity is invalid.");
      }
      const committed = await settings.update((current) => {
        if (current.shareInstallationId !== undefined) {
          if (typeof current.shareInstallationId !== "string" || !INSTALLATION_ID.test(current.shareInstallationId)) {
            throw new Error("Stored share installation identity is invalid.");
          }
          return current;
        }
        return { ...current, shareInstallationId: candidate };
      });
      return committed.shareInstallationId;
    })().catch((error) => {
      installationIdPromise = undefined;
      throw error;
    });
    return installationIdPromise;
  };

  return async (threadId) => {
    if (!Number.isSafeInteger(threadId) || threadId <= 0) {
      throw new TypeError("Share source identity requires a positive thread ID.");
    }
    return `installation:${await installationId()}:thread:${threadId}`;
  };
}

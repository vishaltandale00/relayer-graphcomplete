import { createAuthenticatedErrorGateway } from "./authenticated-error-gateway.mjs";
import { createAuthenticatedErrorReceiver } from "./authenticated-error-receiver.mjs";

function exactReleaseIdentity(value) {
  const keys = ["architecture", "environment", "os", "release"];
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== keys.join("\0")
    || keys.some((key) => typeof value[key] !== "string" || value[key].length === 0)) {
    throw new TypeError("Desktop authenticated error release identity is invalid.");
  }
  return Object.freeze({ ...value });
}

export async function createDesktopAuthenticatedErrorReporting({
  queuePath,
  encrypt,
  decrypt,
  transport,
  releaseIdentity,
  createReceiver = createAuthenticatedErrorReceiver,
} = {}) {
  const release = exactReleaseIdentity(releaseIdentity);
  const gateway = createAuthenticatedErrorGateway({
    queuePath,
    encrypt,
    decrypt,
    transport,
    ...release,
  });
  let receiver = null;
  try {
    receiver = await createReceiver({ gateway });
  } catch {}
  let closePromise;
  const account = Object.freeze({
    transitionIdentity: (identity) => gateway.transitionIdentity(identity),
    retireIdentity: () => gateway.retireIdentity(),
  });

  return Object.freeze({
    account,
    issueReporter: (identity) => gateway.issueReporter(identity),
    issueCapability: (identity) => receiver?.issue(identity) ?? null,
    updateEnvironment: (environment) => gateway.updateEnvironment(environment),
    close() {
      closePromise ??= (async () => {
        await receiver?.close();
        await gateway.close();
      })();
      return closePromise;
    },
  });
}

const SCHEMA = "relayer.authenticated-error-capability/v1";

export function acquireAuthenticatedErrorCapability(issue, component, processGeneration) {
  if (typeof issue !== "function") return null;
  try {
    const capability = issue(component, processGeneration);
    if (capability === null) return null;
    if (typeof capability?.endpoint !== "string"
      || typeof capability.authorization !== "string"
      || typeof capability.revoke !== "function") return null;
    return capability;
  } catch {
    return null;
  }
}

export function authenticatedErrorCapabilityBootstrap(capability) {
  return `${JSON.stringify({
    schema: SCHEMA,
    capability: capability === null ? null : {
      endpoint: capability.endpoint,
      authorization: capability.authorization,
    },
  })}\n`;
}

export function revokeAuthenticatedErrorCapability(capability) {
  try { capability?.revoke(); } catch {}
}

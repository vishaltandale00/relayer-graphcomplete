function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
}

export function requireManagedRuntime(value, expectedRuntimeId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Provider requires the ${expectedRuntimeId} managed runtime.`);
  }
  if (value.runtimeId !== expectedRuntimeId) {
    throw new Error(`Provider requires the ${expectedRuntimeId} managed runtime.`);
  }
  const managedRuntime = {
    runtimeId: expectedRuntimeId,
    version: requiredString(value.version, "Managed runtime version"),
    executable: requiredString(value.executable, "Managed runtime executable"),
  };
  if (expectedRuntimeId === "claude") {
    managedRuntime.moduleUrl = requiredString(value.moduleUrl, "Claude managed runtime module URL");
  } else if (value.moduleUrl != null) {
    managedRuntime.moduleUrl = requiredString(value.moduleUrl, "Managed runtime module URL");
  }
  return Object.freeze(managedRuntime);
}

export function managedRuntimeExecutionDetails(managedRuntime, environment = {}) {
  return Object.freeze({
    ...managedRuntime,
    environment: Object.freeze({ ...environment }),
  });
}

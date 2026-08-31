function errorText(error) {
  const own = error?.stack || String(error);
  return error instanceof AggregateError
    ? [own, ...error.errors.map(errorText)].join("\n")
    : own;
}

export async function closeNodeInputProofResources(resources) {
  const failures = [];
  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      failures.push(new Error(`${resource.name} teardown failed: ${errorText(error)}`, { cause: error }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Node-input Electron proof teardown failed.");
  }
}

export async function completeNodeInputProof({ runScenario, cleanup, recordResult }) {
  const failures = [];
  try {
    await runScenario();
  } catch (error) {
    failures.push(error);
  }

  const provisionalResult = failures.length === 0
    ? { passed: false, error: "Node-input Electron proof teardown has not completed." }
    : { passed: false, error: failures.map(errorText).join("\n\n") };
  try {
    await recordResult(provisionalResult);
  } catch (error) {
    failures.push(new Error(`Provisional proof result recording failed: ${errorText(error)}`, { cause: error }));
  }

  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }

  let result = failures.length === 0
    ? { passed: true }
    : { passed: false, error: failures.map(errorText).join("\n\n") };
  try {
    await recordResult(result);
  } catch (error) {
    failures.push(error);
    result = { passed: false, error: failures.map(errorText).join("\n\n") };
  }
  return { result, exitCode: failures.length === 0 ? 0 : 1 };
}

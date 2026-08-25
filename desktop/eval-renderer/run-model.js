export function runPanelCopy(run) {
  if (run?.kind === "imported-conversation") {
    return {
      title: "Conversation review",
      description: "Open the immutable external conversation in the read-only production workspace or review its eligible judge results.",
    };
  }
  return {
    title: "Test cases",
    description: "Open the judge review or the read-only production workspace for one case × harness execution.",
  };
}

export function annotatedExecutionExportable(run, execution) {
  const executionTerminal = ["passed", "failed", "imported"].includes(execution?.status);
  const threadIds = [...new Set(execution?.threadIds || [])];
  const covered = new Set((execution?.turns || []).map((turn) => String(turn?.threadId)));
  const turnsFinalized = execution?.turns?.length > 0
    && execution.turns.every((turn) => (
      turn?.threadId != null
      && turn?.interactionId != null
      && threadIds.some((threadId) => String(threadId) === String(turn.threadId))
      && ["accepted", "failed", "stopped"].includes(turn.status)
    ))
    && threadIds.every((threadId) => covered.has(String(threadId)));
  return executionTerminal
    && turnsFinalized
    && threadIds.length > 0
    && typeof run?.bundleRef === "string"
    && run.bundleRef.length > 0;
}

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

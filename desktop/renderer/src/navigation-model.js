export function evalSidebarHeading(context) {
  return context?.origin?.kind === "external-conversation-export"
    ? "External conversation"
    : `Cases · ${context?.harnessConfigurationName}`;
}

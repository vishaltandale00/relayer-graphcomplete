/** Narrow Codex app-server option vocabulary used by the codex.basic configuration. */
export type CodexApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexWebSearchMode = "disabled" | "cached" | "live";

const APPROVAL_DECISIONS = new Set(["approve_once", "approve_always", "deny"]);

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validApprovalAction(action) {
  if (action?.kind === "command") {
    return nonEmpty(action.command) && nonEmpty(action.workingDirectory);
  }
  if (action?.kind === "file_change") {
    return nonEmpty(action.action)
      && nonEmpty(action.workingDirectory)
      && Array.isArray(action.affectedFiles)
      && action.affectedFiles.length > 0
      && action.affectedFiles.every(nonEmpty);
  }
  if (action?.kind === "network") {
    return nonEmpty(action.action)
      && nonEmpty(action.networkDestination)
      && (action.workingDirectory === undefined || nonEmpty(action.workingDirectory));
  }
  if (action?.kind === "other") {
    return nonEmpty(action.action)
      && (action.workingDirectory === undefined || nonEmpty(action.workingDirectory));
  }
  return false;
}

export function validApprovalRequest(receipt) {
  const request = receipt?.request;
  const correlation = request?.correlation;
  return nonEmpty(request?.requestId)
    && correlation != null
    && positiveInteger(correlation.threadId)
    && positiveInteger(correlation.interactionId)
    && nonEmpty(correlation.completeCallId)
    && nonEmpty(correlation.harnessSessionId)
    && nonEmpty(request.title)
    && nonEmpty(request.reason)
    && validApprovalAction(request.action)
    && Array.isArray(request.scopeKeys)
    && request.scopeKeys.length > 0
    && request.scopeKeys.every(nonEmpty)
    && new Set(request.scopeKeys).size === request.scopeKeys.length
    && nonEmpty(request.scopeDescription)
    && nonEmpty(request.createdAt);
}

export function approvalReceiptsForThread(state, thread) {
  const approvals = Array.isArray(state?.approvals) ? state.approvals : [];
  return approvals.filter((receipt) => (
    validApprovalRequest(receipt)
    && sameId(receipt.request.correlation.threadId, thread?.id)
  ));
}

export function pendingApprovalsForThread(state, thread) {
  const receipts = approvalReceiptsForThread(state, thread);
  const counts = new Map();
  for (const receipt of receipts) {
    const id = String(receipt.request.requestId);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const interactions = Array.isArray(state?.interactions) ? state.interactions : [];
  return receipts
    .filter((receipt) => {
      const request = receipt.request;
      if (receipt.resolution != null || counts.get(String(request.requestId)) !== 1) return false;
      return interactions.some((interaction) => (
        sameId(interaction.id, request.correlation.interactionId)
        && sameId(interaction.threadId, thread?.id)
        && interaction.completionStatus === "waiting_for_approval"
      ));
    })
    .sort((left, right) => (
      String(left.request.createdAt).localeCompare(String(right.request.createdAt))
      || String(left.request.requestId).localeCompare(String(right.request.requestId))
    ));
}

export function resolvedApprovalHistoryForThread(state, thread) {
  return approvalReceiptsForThread(state, thread)
    .filter((receipt) => receipt.resolution != null)
    .sort((left, right) => (
      String(right.resolution?.resolvedAt || "").localeCompare(String(left.resolution?.resolvedAt || ""))
      || String(left.request.requestId).localeCompare(String(right.request.requestId))
    ));
}

export function selectedPendingApproval(pending, requestId) {
  return pending.find((receipt) => sameId(receipt.request.requestId, requestId))
    || pending[0]
    || null;
}

export function approvalDockMode(pending, history) {
  if (pending.length > 0) return "pending";
  if (history.length > 0) return "history";
  return "hidden";
}

export function approvalQueueTarget(pending, requestId, intent) {
  if (!pending.length) return null;
  const current = Math.max(0, pending.findIndex((receipt) => (
    sameId(receipt.request.requestId, requestId)
  )));
  const index = intent === "first" ? 0
    : intent === "last" ? pending.length - 1
      : (current + Number(intent) + pending.length) % pending.length;
  return pending[index]?.request.requestId ?? null;
}

export function approvalQueueKeyIntent(event, focused) {
  if (!focused || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowLeft") return -1;
  if (event.key === "ArrowRight") return 1;
  if (event.key === "Home") return "first";
  if (event.key === "End") return "last";
  return null;
}

export function validApprovalDecision(decision) {
  return APPROVAL_DECISIONS.has(decision);
}

export function approvalActionPresentation(action) {
  const kind = action?.kind;
  if (kind === "command") {
    return {
      kind,
      label: "Command",
      value: String(action.command || ""),
      workingDirectory: nonEmpty(action.workingDirectory) ? action.workingDirectory : null,
      affectedFiles: [],
    };
  }
  if (kind === "file_change") {
    return {
      kind,
      label: "File change",
      value: String(action.action || ""),
      workingDirectory: nonEmpty(action.workingDirectory) ? action.workingDirectory : null,
      affectedFiles: Array.isArray(action.affectedFiles) ? action.affectedFiles.map(String) : [],
    };
  }
  if (kind === "network") {
    return {
      kind,
      label: "Network access",
      value: [action.action, action.networkDestination].filter(nonEmpty).join(" · "),
      workingDirectory: nonEmpty(action.workingDirectory) ? action.workingDirectory : null,
      affectedFiles: [],
    };
  }
  return {
    kind: "other",
    label: "Action",
    value: String(action?.action || ""),
    workingDirectory: nonEmpty(action?.workingDirectory) ? action.workingDirectory : null,
    affectedFiles: [],
  };
}

export function approvalResolutionLabel(receipt) {
  const outcome = receipt?.resolution?.outcome;
  if (outcome === "approved") {
    return receipt.resolution.decision === "approve_always"
      ? "Approved for this session"
      : "Approved once";
  }
  if (outcome === "denied") return "Denied";
  if (outcome === "cancelled") return "Cancelled";
  if (outcome === "expired") return "Expired";
  if (outcome === "aborted") return "Aborted";
  return "Resolved";
}

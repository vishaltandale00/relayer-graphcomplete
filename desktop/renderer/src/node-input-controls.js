const SUPPORTED_CONTROLS = new Set(["text", "single_select", "multi_select"]);

function requiredIdentity(value, name) {
  if (value === undefined || value === null || String(value).length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableCopy(value) {
  return deepFreeze(clone(value));
}

function normalizedSelectedKeys(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function selectedLabels(action, value) {
  const labels = new Map((action?.options || []).map((option) => [String(option.key), option.label]));
  return normalizedSelectedKeys(value).map((key) => labels.get(key) ?? key);
}

function validationIssue(code, message) {
  return Object.freeze({ code, message });
}

export function createInputOccurrence(
  presentingInteractionNodeId,
  presentingLayerId,
  actionId,
) {
  return Object.freeze({
    presentingInteractionNodeId: requiredIdentity(
      presentingInteractionNodeId,
      "presentingInteractionNodeId",
    ),
    presentingLayerId: requiredIdentity(presentingLayerId, "presentingLayerId"),
    actionId: requiredIdentity(actionId, "actionId"),
  });
}

export function inputActionReviewRef(occurrence) {
  const value = createInputOccurrence(
    occurrence?.presentingInteractionNodeId,
    occurrence?.presentingLayerId,
    occurrence?.actionId,
  );
  return `input-action-${value.presentingInteractionNodeId}-${value.presentingLayerId}-${value.actionId}`;
}

export function inputOccurrenceKey(occurrence) {
  return JSON.stringify([
    String(requiredIdentity(occurrence?.presentingInteractionNodeId, "presentingInteractionNodeId")),
    String(requiredIdentity(occurrence?.presentingLayerId, "presentingLayerId")),
    String(requiredIdentity(occurrence?.actionId, "actionId")),
  ]);
}

export function threadInputOccurrenceKey(threadId, occurrence) {
  return JSON.stringify([
    String(requiredIdentity(threadId, "threadId")),
    ...JSON.parse(inputOccurrenceKey(occurrence)),
  ]);
}

export function committedInputAttachment(draft, occurrence) {
  const key = inputOccurrenceKey(occurrence);
  return (draft?.attachments || []).find(
    (attachment) => inputOccurrenceKey(attachment.occurrence) === key,
  ) ?? null;
}

export function initialInputStageValue(action, attachment = null) {
  if (action?.control === "text") {
    return attachment?.value?.text ?? "";
  }
  if (action?.control === "single_select" || action?.control === "multi_select") {
    return Object.freeze([...(attachment?.value?.selectedKeys || [])].map(String));
  }
  return null;
}

export function validateInputStage(action, value) {
  if (!SUPPORTED_CONTROLS.has(action?.control)) {
    return validationIssue(
      "input_action_control_unsupported",
      "Use text, single_select, or multi_select.",
    );
  }
  if (action.control === "text") {
    return typeof value === "string" && value.trim().length > 0
      ? null
      : validationIssue("input_text_blank", "Enter non-whitespace text or detach the input.");
  }
  if (!Array.isArray(value)) {
    return validationIssue(
      "input_action_snapshot_mismatch",
      "Refresh the accepted action and recommit its value.",
    );
  }
  const keys = value.map(String);
  if (new Set(keys).size !== keys.length) {
    return validationIssue("input_option_duplicate", "Remove repeated multi-select keys.");
  }
  const known = new Set((action.options || []).map((option) => String(option.key)));
  if (keys.some((key) => !known.has(key))) {
    return validationIssue(
      "input_option_unknown",
      "Select only keys from the accepted action snapshot.",
    );
  }
  const countValid = action.control === "single_select"
    ? keys.length === 1
    : keys.length >= (action.minimumSelections ?? 1);
  return countValid
    ? null
    : validationIssue(
      "input_selection_count",
      "Meet that action's exact selection count or minimum.",
    );
}

export function inputStageValueForApi(action, value) {
  const issue = validateInputStage(action, value);
  if (issue) {
    const error = new Error(issue.message);
    error.name = "InputStageValidationError";
    error.code = issue.code;
    throw error;
  }
  return action.control === "text"
    ? Object.freeze({ text: value })
    : Object.freeze({ selectedKeys: [...value].map(String).sort() });
}

export function inputStageValuesEqual(action, left, right) {
  if (action?.control === "text") return left === right;
  if (action?.control === "single_select" || action?.control === "multi_select") {
    return JSON.stringify(normalizedSelectedKeys(left).sort())
      === JSON.stringify(normalizedSelectedKeys(right).sort());
  }
  return false;
}

export function summarizeInputStage(action, value) {
  if (action?.control === "text") return typeof value === "string" ? value : "";
  if (action?.control === "single_select" || action?.control === "multi_select") {
    return selectedLabels(action, value).join(", ");
  }
  return "";
}

export function inspectedInputDraftRevision(draft) {
  return Number.isInteger(draft?.revision) ? draft.revision : null;
}

export function captureTextControlState(control) {
  if (!control || typeof control.selectionStart !== "number") return null;
  return Object.freeze({
    selectionStart: control.selectionStart,
    selectionEnd: control.selectionEnd,
    selectionDirection: control.selectionDirection || "none",
    scrollTop: control.scrollTop || 0,
    scrollLeft: control.scrollLeft || 0,
  });
}

export function restoreTextControlState(control, state) {
  if (!control || !state) return;
  control.setSelectionRange?.(
    state.selectionStart,
    state.selectionEnd,
    state.selectionDirection,
  );
  control.scrollTop = state.scrollTop;
  control.scrollLeft = state.scrollLeft;
}

function normalizedDraft(threadId, response) {
  return immutableCopy({
    ...response,
    threadId: response?.threadId ?? threadId,
    revision: response?.revision ?? 0,
    attachments: response?.attachments || [],
  });
}

export function createNodeInputDraftController({ api, onChange = () => {} } = {}) {
  if (!api) throw new TypeError("api is required");
  const drafts = new Map();
  const mutations = new Map();
  const key = (threadId) => String(requiredIdentity(threadId, "threadId"));
  const requireCurrent = (threadId) => {
    const current = drafts.get(key(threadId));
    if (!current) throw new Error("Load the thread input draft before changing it.");
    return current;
  };
  const adopt = (threadId, response) => {
    const draft = normalizedDraft(threadId, response);
    drafts.set(key(threadId), draft);
    onChange(threadId, draft);
    return draft;
  };
  const enqueue = (threadId, operation) => {
    const threadKey = key(threadId);
    const prior = mutations.get(threadKey) || Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    mutations.set(threadKey, next);
    void next.finally(() => {
      if (mutations.get(threadKey) === next) mutations.delete(threadKey);
    }).catch(() => undefined);
    return next;
  };

  return Object.freeze({
    async load(threadId) {
      return enqueue(threadId, async () => {
        const response = await api.get(threadId);
        return adopt(threadId, response);
      });
    },
    current(threadId) {
      return drafts.get(key(threadId)) ?? null;
    },
    async commit(threadId, occurrence, action, stagedValue) {
      const value = inputStageValueForApi(action, stagedValue);
      return enqueue(threadId, async () => {
        const current = requireCurrent(threadId);
        const response = await api.commit(threadId, occurrence, value, current.revision);
        return adopt(threadId, response);
      });
    },
    async detach(threadId, occurrence) {
      return enqueue(threadId, async () => {
        const current = requireCurrent(threadId);
        const response = await api.detach(threadId, occurrence, current.revision);
        return adopt(threadId, response);
      });
    },
  });
}

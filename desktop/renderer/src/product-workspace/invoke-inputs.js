import { committedInputAttachment, initialInputStageValue, inputStageValuesEqual, validateInputStage } from "../node-input-controls.js";

// Bindings are canonical action identities, never labels or DOM proximity.
export function connectedInvokeInputs(action, actions) {
  return (action.inputActionIds ?? []).map((id) => actions.find((candidate) =>
    String(candidate.id) === String(id)
    && candidate.kind === "input"
    && String(candidate.sourceNodeId) === String(action.sourceNodeId)));
}

// Saved answer provenance is independent of the Layer presenting Invoke.
// Prefer the clicked occurrence, then the latest valid saved choice for the
// same canonical Input and owning Node. Never manufacture a new occurrence.
export function boundInputAttachment(draft, input, occurrence) {
  const semantic = input.input ?? input;
  const valid = attachment => String(attachment.occurrence.actionId) === String(input.id)
    && String(attachment.sourceNodeId) === String(input.sourceNodeId)
    && !validateInputStage(semantic, initialInputStageValue(semantic, attachment));
  const exact = committedInputAttachment(draft, occurrence);
  if (exact && valid(exact)) return exact;
  const epoch = attachment => /^\d+$/.test(attachment.committedAt) ? BigInt(attachment.committedAt) : 0n;
  return (draft?.attachments ?? []).filter(valid).sort((a, b) => {
    const left = epoch(a), right = epoch(b);
    return (right > left ? 1 : right < left ? -1 : 0)
      || b.occurrence.presentingInteractionNodeId - a.occurrence.presentingInteractionNodeId
      || b.occurrence.presentingLayerId - a.occurrence.presentingLayerId
      || b.occurrence.actionId - a.occurrence.actionId;
  })[0] ?? null;
}

export function invokeInputIssue(action, { actions, draft, occurrence, staged, pending }) {
  for (const input of connectedInvokeInputs(action, actions)) {
    if (!input) return "A connected input is unavailable.";
    const inputOccurrence = occurrence(input);
    if (!inputOccurrence) return "Connected inputs are unavailable in this view.";
    const attachment = committedInputAttachment(draft, inputOccurrence);
    const name = (input.input ?? input).prompt;
    if (!attachment) return `Confirm ${name} before invoking.`;
    if (pending(input)) return `Saving ${name}…`;
    const value = staged(input);
    if (value !== undefined && !inputStageValuesEqual(input.input ?? input, value,
      initialInputStageValue(input.input ?? input, attachment))) {
      return `Confirm the changed ${name} before invoking.`;
    }
  }
  return null;
}

// Connected components show shared fields once, alongside all their consumers.
export function invokeInputGroups(actions) {
  const groups = [];
  for (const action of actions.filter((item) => item.kind === "invoke" && item.inputActionIds?.length)) {
    const inputIds = new Set(action.inputActionIds.map(String));
    const overlapping = groups.filter((group) => [...inputIds].some((id) => group.inputIds.has(id)));
    const group = { inputIds, invokes: [action] };
    for (const previous of overlapping) {
      for (const id of previous.inputIds) group.inputIds.add(id);
      group.invokes.push(...previous.invokes);
      groups.splice(groups.indexOf(previous), 1);
    }
    groups.push(group);
  }
  return groups;
}

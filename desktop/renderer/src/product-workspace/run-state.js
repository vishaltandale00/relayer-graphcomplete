import { interactionReturnsToUnsent } from "../interaction-failure-model.js";

// Explicit run states shown as symbols (PRD §8.1, :289). Shape, tooltip and accessible name carry
// the state; colour comes from the design's running, warning and danger roles.
export const THREAD_ACTIVITY = Object.freeze({
  running: Object.freeze({ label: "Running", icon: "LoaderCircle", live: true }),
  stopping: Object.freeze({ label: "Stopping…", icon: "Square", live: true }),
  needs_approval: Object.freeze({ label: "Needs approval", icon: "Hand", live: true }),
  failed: Object.freeze({ label: "Failed", icon: "OctagonX", live: false }),
});

const ACTIVE_STATUSES = new Set(["not_started", "running", "submitted", "waiting_for_approval"]);

// A thread's symbol from its latest interaction; the app server applies the same rule to thread lists.
export function interactionActivity(interaction) {
  const status = interaction?.completionStatus;
  if (ACTIVE_STATUSES.has(status) && interaction.stopRequested && !interaction.stopError) return "stopping";
  if (status === "waiting_for_approval") return "needs_approval";
  if (ACTIVE_STATUSES.has(status)) return "running";
  if (status === "failed") return "failed";
  return null;
}

/**
 * A thread's symbol from its human turns, as the app server computes it for thread lists. Runs
 * from invoke actions run beside the message turns, so the most urgent active turn wins over
 * the latest one; otherwise the latest turn's failure shows.
 */
export function threadActivity(turns = []) {
  const active = turns.filter(runIsActive);
  const stopping = (turn) => turn.stopRequested && !turn.stopError;
  if (active.some((turn) => turn.completionStatus === "waiting_for_approval" && !stopping(turn))) return "needs_approval";
  if (active.some(stopping)) return "stopping";
  if (active.length > 0) return "running";
  return turns.at(-1)?.completionStatus === "failed" ? "failed" : null;
}

// Node marks (visual redesign b-structure-spec §4): a hollow dashed draft, or the state of the
// latest child run the node's actions started. Accepted and never-invoked nodes carry no mark.
export const NODE_RUN_STATE = Object.freeze({
  draft: Object.freeze({ label: "Draft", icon: null }),
  running: Object.freeze({ label: "Running", icon: "LoaderCircle" }),
  stopped: Object.freeze({ label: "Stopped", icon: "Square" }),
  failed: Object.freeze({ label: "Failed", icon: "OctagonX" }),
});

function nodeInvocations(node, actions, invocations) {
  const actionIds = new Set(actions
    .filter((action) => String(action.sourceNodeId) === String(node?.id))
    .map((action) => String(action.id)));
  return invocations.filter((invocation) => actionIds.has(String(invocation.actionId)));
}

// The product row wins over the invocation summary, which can lag behind it.
function invocationRun(invocation, interactions) {
  return interactions.find((interaction) => String(interaction.id) === String(invocation.resultInteractionId))
    ?? { id: invocation.resultInteractionId, completionStatus: invocation.resultCompletionStatus };
}

// A run a model failure returned to unsent is not running: its action offers Retry.
function runIsActive(run) {
  return ACTIVE_STATUSES.has(run.completionStatus) && !interactionReturnsToUnsent(run);
}

/**
 * The active runs a person started from the node's invoke actions, oldest first: each gets its
 * own Stop on the node. An agent's child is never one, because only its parent agent may stop it.
 */
export function nodeActiveRuns(node, actions = [], invocations = [], interactions = []) {
  return nodeInvocations(node, actions, invocations)
    .filter((invocation) => invocation.agentInvoked !== true)
    .map((invocation) => ({ invocation, run: invocationRun(invocation, interactions) }))
    .filter(({ run }) => runIsActive(run))
    .sort((left, right) => Number(left.run.id) - Number(right.run.id));
}

// Runs from one node can run at once, so any active run marks it running. Otherwise the latest
// run's terminal state shows; a model failure returned to unsent shows as failed.
export function nodeRunState(node, actions = [], invocations = [], interactions = []) {
  if (node?.state === "draft") return "draft";
  const runs = nodeInvocations(node, actions, invocations)
    .map((invocation) => invocationRun(invocation, interactions));
  if (runs.some(runIsActive)) return "running";
  const latest = runs.reduce((newest, run) => (
    !newest || Number(run.id) > Number(newest.id) ? run : newest
  ), null);
  if (latest?.completionStatus === "stopped") return "stopped";
  if (latest?.completionStatus === "failed" || interactionReturnsToUnsent(latest)) return "failed";
  return null;
}

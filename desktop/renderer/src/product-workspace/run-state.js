import { interactionReturnsToUnsent } from "../interaction-failure-model.js";

// Explicit run states shown as symbols (PRD §8.1, :289). Shape, tooltip and accessible name carry
// the state; colour comes from the design's running, warning and danger roles.
export const THREAD_ACTIVITY = Object.freeze({
  running: Object.freeze({ label: "Running", icon: "LoaderCircle", live: true }),
  stopping: Object.freeze({ label: "Stopping…", icon: "Square", live: true }),
  needs_approval: Object.freeze({ label: "Needs approval", icon: "Hand", live: true }),
  failed: Object.freeze({ label: "Failed", icon: "OctagonX", live: false }),
});

// A run queued behind another on its node (#718) is active work: it starts once that run settles.
const ACTIVE_STATUSES = new Set(["not_started", "queued", "running", "submitted", "waiting_for_approval"]);

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
 * A thread's symbol from its human turns, as the app server computes it for thread lists. Every
 * human-started run, message or invoke, runs beside the others (#719), so the symbol means "any
 * run active": the most urgent active run wins over the latest turn, even a finished one.
 * Otherwise the latest turn's failure shows.
 */
export function threadActivity(turns = []) {
  const active = turns.filter(runIsActive);
  const stopping = (turn) => turn.stopRequested && !turn.stopError;
  if (active.some((turn) => turn.completionStatus === "waiting_for_approval" && !stopping(turn))) return "needs_approval";
  if (active.some(stopping)) return "stopping";
  if (active.length > 0) return "running";
  return turns.at(-1)?.completionStatus === "failed" ? "failed" : null;
}

/**
 * An invoke whose preparation failed before anything ran waits for its action's Retry, so it is
 * not running, as the app server's thread state also treats it. Its failure, if it failed, still
 * shows.
 */
export function withoutPreparationsAwaitingRetry(turns = [], invocations = []) {
  const awaitingRetry = new Set(invocations
    .filter((invocation) => invocation.preparationRecoverable === true)
    .map((invocation) => String(invocation.resultInteractionId)));
  return turns.filter((turn) => !awaitingRetry.has(String(turn.id)) || !ACTIVE_STATUSES.has(turn.completionStatus));
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

// The statuses the product's Stop accepts. A run still starting has nothing to stop yet; a
// queued run stops without starting.
const STOPPABLE_STATUSES = new Set(["queued", "submitted", "running", "waiting_for_approval"]);

/**
 * The active runs a person started from the node's invoke actions, oldest first: each gets its
 * own Stop on the node. Runs on one node run in order, so later ones wait as queued. An agent's child is never one, because only its parent agent may stop it,
 * and neither is a preparation waiting for its action's Retry.
 */
export function nodeActiveRuns(node, actions = [], invocations = [], interactions = []) {
  return nodeInvocations(node, actions, invocations)
    .filter((invocation) => invocation.agentInvoked !== true && invocation.preparationRecoverable !== true)
    .map((invocation) => ({ invocation, run: invocationRun(invocation, interactions) }))
    .filter(({ run }) => runIsActive(run) && STOPPABLE_STATUSES.has(run.completionStatus))
    .sort((left, right) => Number(left.run.id) - Number(right.run.id));
}

// Runs from one node can run at once, so any active run marks it running. Otherwise the latest
// run's terminal state shows; a model failure returned to unsent shows as failed.
export function nodeRunState(node, actions = [], invocations = [], interactions = []) {
  if (node?.state === "draft") return "draft";
  const runs = nodeInvocations(node, actions, invocations)
    .map((invocation) => ({ invocation, run: invocationRun(invocation, interactions) }));
  // A preparation waiting for its action's Retry is not running.
  if (runs.some(({ invocation, run }) => invocation.preparationRecoverable !== true && runIsActive(run))) return "running";
  const latest = runs.map(({ run }) => run).reduce((newest, run) => (
    !newest || Number(run.id) > Number(newest.id) ? run : newest
  ), null);
  if (latest?.completionStatus === "stopped") return "stopped";
  if (latest?.completionStatus === "failed" || interactionReturnsToUnsent(latest)) return "failed";
  return null;
}

// The run a person can stop or remove, from an interaction row. An agent's child is never one,
// because only its parent agent may stop it; neither is a preparation waiting for its action's
// Retry, nor a run a model failure returned to unsent.
function stoppableHumanRun(run, invocationsByResult) {
  const invocation = invocationsByResult.get(String(run?.id));
  if (invocation?.agentInvoked === true || invocation?.preparationRecoverable === true) return false;
  return runIsActive(run) && STOPPABLE_STATUSES.has(run.completionStatus);
}

function invocationsByResult(invocations = []) {
  return new Map(invocations.map((invocation) => [String(invocation.resultInteractionId), invocation]));
}

/**
 * Every run in the thread a person can stop now, oldest first: its message turns and the runs its
 * invoke actions started. Thread messages run in parallel (#719), so this is what the thread
 * menu's "Stop all runs (N)" stops or removes.
 */
export function threadActiveRuns(turns = [], invocations = []) {
  const byResult = invocationsByResult(invocations);
  return turns
    .filter((turn) => stoppableHumanRun(turn, byResult))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

/**
 * The status and Stop of the run an interaction node started (#719). Each run, including one
 * sent from the message box, shows them on its own interaction node. A run that has not started
 * is removed from its queue instead, keeping its text (#721).
 */
export function interactionRunControl(interaction, invocations = []) {
  if (!interaction || !stoppableHumanRun(interaction, invocationsByResult(invocations))) return null;
  return { run: interaction, verb: interaction.completionStatus === "queued" ? "Remove" : "Stop" };
}

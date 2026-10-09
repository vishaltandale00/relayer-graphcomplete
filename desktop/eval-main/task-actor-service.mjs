import { resolveEvaluatorSelection, completionJudgeSpec, participantMayStopIncomplete } from "./evaluator-selection.mjs";
import { setupDigest } from "./setup-registry.mjs";
import { createCompletionJudge as createNativeCompletionJudge, validateCompletionAssessment, COMPLETION_JUDGE_EVIDENCE_CONTRACT } from "./task-completion-judge.mjs";
import { randomUUID } from "node:crypto";
import { abortable } from "./abortable.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { ACTOR_ACTION_SCHEMA, ACTOR_OBSERVATION_CONTRACT, ACTOR_SETTLED_OBSERVATION_CONTRACT, ACTOR_PROMPT_VERSION, actorConfiguration, actorPrompt, createCodexTaskActor, validateActorAction } from "./task-actor.mjs";

// Classification may inspect native errors, but evidence and UI use only these
// closed categories and fixed messages; never copy provider text or error.name.
function actorFailure(error, { cancelled = false, timedOut = false } = {}) {
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  const status = error?.status ?? error?.statusCode;
  const text = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  let category = "runtime_failure";
  if (cancelled) category = "cancelled";
  else if (timedOut || error?.name === "TimeoutError" || code === "etimedout" || /timed? ?out|timeout/.test(text)) category = "timeout";
  else if (status === 429 || /rate[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)/.test(`${code} ${text}`)) category = "rate_limit";
  else if ([401, 403].includes(status) || /authentication|unauthorized|not[_ -]?logged[_ -]?in|invalid[_ -]?(?:api[_ -]?)?key|token.{0,30}expired/.test(`${code} ${text}`)) category = "authentication";
  else if (code === "actor_control_stale") category = "stale_control";
  else if (code === "actor_control_unavailable") category = "unavailable_control";
  else if (["actor_invalid_action", "actor_inconsistent_finish"].includes(code)) category = "invalid_action";
  else if (code === "actor_effort_unsupported") category = "unsupported_effort";
  else if (/model[_ -](?:not[_ -]found|unsupported)|unsupported[_ -]model/.test(code)
    || /(?:model|reasoning effort).{0,120}(?:not supported|unsupported|not found|does not exist)/.test(text)) category = "unsupported_model";
  const messages = {
    cancelled: "Actor was cancelled. No action is replayed automatically.",
    timeout: "Actor timed out. Review the saved trajectory before starting another task.",
    rate_limit: "Actor provider reached a rate or usage limit. Wait or check account limits before starting another task.",
    authentication: "Actor authentication is unavailable. Reconnect the Eval profile's Codex subscription in Settings.",
    unsupported_model: "Choose a model available to the connected Codex subscription before starting another task.",
    unsupported_effort: "Choose a reasoning effort supported by the actor model before starting another task.",
    stale_control: "The observed control reference expired before the action. No action was replayed.",
    unavailable_control: "The observed control became hidden, detached, or disabled before the action. No action was replayed.",
    invalid_action: "The actor response did not satisfy the action contract. No action was executed.",
    runtime_failure: "Actor runtime failed without claiming task success. No action is replayed automatically.",
  };
  return { category, message: messages[category] };
}

export class TaskActorService {
  constructor({ tasks, resolveRuntime, openBrowser, createActor = createCodexTaskActor, resolveCompletionJudgeRuntime = null, createCompletionJudge = createNativeCompletionJudge, pollMs = 250, deadlineMs = null, setupRegistry = null }) {
    Object.assign(this, { tasks, resolveRuntime, openBrowser, createActor, resolveCompletionJudgeRuntime, createCompletionJudge, pollMs, deadlineMs, setupRegistry });
    this.running = new Map();
  }
  async create(selection) {
    const resolved = resolveEvaluatorSelection(this.setupRegistry, selection);
    selection = resolved.selection;
    const setup = resolved.actorSetup;
    const config = setup ? actorConfiguration({ ...setup.settings, promptTemplate: setup.promptTemplate, promptVersion: setup.promptVersion }) : actorConfiguration(selection.actor);
    const startupId = selection.startupId ?? randomUUID();
    if (typeof startupId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(startupId) || this.running.has(startupId)) throw new Error("Invalid actor startup identity.");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.deadlineMs ?? config.timeoutMs)]);
    let resolveStarted, rejectStarted, task, completionJudge;
    const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const run = { controller, done: null };
    this.running.set(startupId, run);
    run.done = (async () => {
      try {
        // The same deadline covers discovery, preparation and all user actions.
        const runtime = await abortable(signal, () => this.resolveRuntime(config, { signal }));
        const judgeSpec = resolved.completionJudgeSetup?.spec ?? setup?.behaviorContract?.completionJudge;
        if (judgeSpec) {
          if (!this.resolveCompletionJudgeRuntime || !this.createCompletionJudge) throw new Error("Completion judge is unavailable.");
          const judgeRuntime = await abortable(signal, () => this.resolveCompletionJudgeRuntime(structuredClone(judgeSpec), { signal }));
          completionJudge = await abortable(signal, () => this.createCompletionJudge({ runtime: judgeRuntime, config: structuredClone(judgeSpec), signal }));
        }
        signal.throwIfAborted();
        task = await this.tasks.create({ ...selection, mode: "simulated", actor: config, ...(setup ? { actorSetupRevisionId: setup.id } : {}) }, { signal });
        this.running.set(task.id, run);
        this.running.delete(startupId);
        resolveStarted(task);
        await this.run(task.id, runtime, controller.signal, signal, completionJudge);
      } catch (error) {
        const safe = actorFailure(error, { cancelled: controller.signal.aborted, timedOut: signal.aborted && !controller.signal.aborted });
        rejectStarted(Object.assign(new Error(safe.message), { code: safe.category }));
        if (task) await this.tasks.interruptActor(task.id, controller.signal.aborted ? "actor_cancelled" : signal.aborted ? "actor_timeout" : "actor_failed");
      } finally { try { await completionJudge?.close(); } finally { this.running.delete(startupId); if (task) this.running.delete(task.id); } }
    })();
    return started;
  }
  async settled(id, signal, observeCurrent = null) {
    while (true) {
      signal.throwIfAborted();
      const task = this.tasks.get(id);
      if (task.status !== "active") throw new Error("Task is no longer active.");
      try { await this.tasks.settled(task, { signal }); return task; }
      catch (error) { if (error.status !== 409) throw error; }
      if (observeCurrent) await observeCurrent(task);
      await delay(this.pollMs, undefined, { signal });
    }
  }
  async run(id, runtime, cancellation, deadlineSignal, completionJudge = null) {
    const task = this.tasks.get(id);
    const signal = deadlineSignal ?? AbortSignal.any([cancellation, AbortSignal.timeout(this.deadlineMs ?? task.actor.timeoutMs)]);
    const prompt = actorPrompt({ config: task.actor, request: task.prepared.plan[0].prompts[0], endpoint: task.endpoint, privateBrief: task.prepared.humanBrief });
    let actor;
    let browser;
    let phase = "startup";
    try {
      await this.tasks.actorEvent(id, "actor_started", { configuration: task.actor, prompt });
      actor = await this.createActor({ runtime, config: task.actor, prompt, outputSchema: task.actorSetup?.behaviorContract?.actionSchema });
      signal.throwIfAborted();
      const observationContract = task.actorSetup ? task.actorSetup.behaviorContract?.observationContract ?? null
        : task.actor.promptVersion === ACTOR_PROMPT_VERSION ? ACTOR_OBSERVATION_CONTRACT : ACTOR_SETTLED_OBSERVATION_CONTRACT;
      browser = await this.openBrowser(id, signal, structuredClone(observationContract));
      const currentNative = observationContract?.id === "task-actor-observation-v3";
      let previousPointer = null;
      let currentCaptures = 0;
      const currentCaptureLimit = task.actor.maxActions * 2 + 1;
      let limitRecorded = false;
      let actionsUsed = 0;
      let repeatCurrent = false;
      const observeCurrent = currentNative ? async current => {
        if (currentCaptures >= currentCaptureLimit) {
          if (!limitRecorded) {
            await this.tasks.actorEvent(id, "actor_current_limit", { reason: "current_capture_limit", limit: currentCaptureLimit });
            limitRecorded = true;
          }
          return;
        }
        const submission = current.events.findLast(event => event.kind === "submission" && event.interactionId != null
          && (event.outcome == null || event.outcome === "accepted"));
        if (!submission) return;
        const detail = await this.tasks.detail(submission.threadId, { signal });
        const turn = detail.interactions.find(item => String(item.id) === String(submission.interactionId));
        if (!turn) throw new Error("Submitted interaction is unavailable.");
        const expected = { threadId: submission.threadId, turnId: submission.interactionId, submittedAt: Date.parse(submission.at), workingOnly: true,
          ...(turn.latestAttempt?.id == null ? {} : { attemptId: turn.latestAttempt.id }) };
        phase = "observe_current";
        const captured = await abortable(signal, () => browser.observeCurrent(expected, repeatCurrent ? null : previousPointer));
        signal.throwIfAborted();
        if (!captured) return;
        currentCaptures++;
        if (captured.kind === "gap") {
          await this.tasks.actorEvent(id, "actor_current_gap", { pointer: captured.pointer, reason: captured.reason });
          return;
        }
        const pointer = captured.pointer;
        if (actionsUsed >= task.actor.maxActions) captured.observation.availableActions = [];
        const workingSchema = structuredClone(task.actorSetup?.behaviorContract?.actionSchema ?? ACTOR_ACTION_SCHEMA);
        workingSchema.properties.kind.enum = workingSchema.properties.kind.enum.filter(kind => captured.observation.availableActions.includes(kind));
        const sameAttempt = previousPointer && String(pointer.threadId) === String(previousPointer.threadId)
          && String(pointer.turnId) === String(previousPointer.turnId) && String(pointer.attemptId) === String(previousPointer.attemptId);
        const missing = pointer.revision - (sameAttempt ? previousPointer.revision : 0) - 1;
        if (missing > 0) await this.tasks.actorEvent(id, "actor_current_gap", { pointer, reason: "revisions_not_observed", missingRevisions: missing });
        const observed = await this.tasks.actorEvent(id, "actor_observation", { phase: "current", pointer, submissionEventId: submission.id,
          observation: captured.observation, actionSchema: workingSchema.properties.kind.enum.length ? workingSchema : null });
        signal.throwIfAborted();
        phase = "perceive_current";
        const reaction = await abortable(signal, () => actor.observe(captured.observation, signal, { actionSchema: workingSchema }));
        signal.throwIfAborted();
        if (!reaction || typeof reaction.comment !== "string" || reaction.comment.length > 8000) throw Object.assign(new Error("Invalid current-update reaction."), { code: "actor_invalid_action" });
        await this.tasks.actorEvent(id, "actor_current_reaction", { observationEventId: observed.id, comment: reaction.comment, usage: reaction.usage ?? null });
        previousPointer = pointer;
        repeatCurrent = false;
        if (reaction.action != null) {
          validateActorAction(reaction.action);
          if (!captured.observation.availableActions.includes(reaction.action.kind)
            || actionsUsed >= task.actor.maxActions) throw Object.assign(new Error("Unavailable working action."), { code: "actor_invalid_action" });
          actionsUsed++;
          const intent = await this.tasks.actorEvent(id, "actor_action", { phase: "current", observationEventId: observed.id, action: reaction.action, usage: reaction.usage ?? null });
          signal.throwIfAborted();
          phase = "act_current";
          try {
            await abortable(signal, () => browser.act(reaction.action, { actionEventId: intent.id, observationEventId: observed.id, current: { expected, pointer } }));
            await this.tasks.actorEvent(id, "actor_action_completed", { actionEventId: intent.id });
          } catch (error) {
            if (error.actionDispatched !== false || !["actor_control_stale", "actor_control_unavailable"].includes(error.code)) throw error;
            await this.tasks.actorEvent(id, "actor_action_failed", { actionEventId: intent.id, actionDispatched: false, category: actorFailure(error).category, retryAllowed: actionsUsed < task.actor.maxActions, message: "Working control changed before dispatch. Obtain a fresh observation." });
          }
          repeatCurrent = true;
        }
      } : null;
      let observedSubmission;
      let finishRepairPending = false;
      let controlRepairPending = false;
      let judgeInteractionRequired = false;
      let completionJudgeFeedback = null;
      for (let index = 0; index <= task.actor.maxActions; index++) {
        phase = "settle";
        const current = await this.settled(id, signal, observeCurrent);
        const submission = current.events.findLast((event) => event.kind === "submission" && event.interactionId != null && (event.outcome == null || event.outcome === "accepted"));
        let expected;
        if (submission && submission.id !== observedSubmission) {
          const detail = await this.tasks.detail(submission.threadId, { signal });
          const turn = detail.interactions.find((item) => String(item.id) === String(submission.interactionId));
          if (!turn) throw new Error("Submitted interaction is unavailable.");
          const attemptId = turn.latestAttempt?.id;
          if (submission.path?.endsWith("/retry") && attemptId == null) throw new Error("Retried interaction has no settled attempt identity.");
          expected = { threadId: submission.threadId, turnId: submission.interactionId, submittedAt: Date.parse(submission.at), ...(attemptId == null ? {} : { attemptId }) };
        }
        phase = "observe";
        const observation = await browser.observe(expected);
        const actionSchema = structuredClone(task.actorSetup?.behaviorContract?.actionSchema ?? ACTOR_ACTION_SCHEMA);
        if (current.step + 1 >= current.prepared.plan.length || current.completions >= current.maxCompletions) {
          actionSchema.properties.kind.enum = actionSchema.properties.kind.enum.filter(kind => kind !== "next_step");
        }
        if (judgeInteractionRequired) actionSchema.properties.kind.enum = actionSchema.properties.kind.enum.filter(kind => kind !== "finish");
        observation.availableActions = [...actionSchema.properties.kind.enum];
        if (completionJudgeFeedback) observation.completionJudgeFeedback = completionJudgeFeedback;
        if (finishRepairPending) observation.previousActionError = "Your previous finish decision was rejected before execution. Reconsider using the visible evidence. endpoint_reached requires endpointStatus reached and empty remainingWork. If work remains, report incomplete or uncertain with satisfied or abandoned. Do not erase unfinished work merely to satisfy the format.";
        else if (controlRepairPending) observation.previousActionError = "Your previous control action was not executed because its observed control was no longer available. Choose a new action from this fresh workspace observation; do not reuse an old reference.";
        observedSubmission = submission?.id;
        const observed = await this.tasks.actorEvent(id, "actor_observation", { observation, actionSchema });
        signal.throwIfAborted();
        if (actionsUsed >= task.actor.maxActions) {
          await this.tasks.actorEvent(id, "actor_limit", { reason: "action_limit" });
          await this.tasks.finish(id, { reason: completionJudge ? "budget_exhausted" : "abandoned" }, { signal });
          return;
        }
        phase = "decide";
        actionsUsed++;
        const { action, usage } = await actor.decide(observation, signal, { outputSchema: actionSchema });
        phase = "validate";
        try { validateActorAction(action); }
        catch (error) {
          if (error.code !== "actor_inconsistent_finish" || action.kind !== "finish") throw error;
          const retryAllowed = !finishRepairPending && actionsUsed < task.actor.maxActions;
          await this.tasks.actorEvent(id, "actor_action_rejected", { observationEventId: observed.id, action, usage, category: "inconsistent_finish", retryAllowed, message: "Finish fields contradicted each other. No action was executed." });
          if (!retryAllowed) throw error;
          finishRepairPending = true;
          continue;
        }
        if (!observation.availableActions.includes(action.kind)) throw Object.assign(new Error("Actor chose an unavailable action."), { code: "actor_invalid_action" });
        finishRepairPending = false;
        signal.throwIfAborted();
        // An intervening stop/finish or product request invalidates this choice.
        await this.tasks.settled(this.tasks.get(id), { signal });
        const intent = await this.tasks.actorEvent(id, "actor_action", { observationEventId: observed.id, action, usage });
        signal.throwIfAborted();
        if (action.kind === "finish") {
          await this.tasks.actorEvent(id, "actor_satisfaction", { scale: "actor-1-4", value: action.satisfaction, comment: action.comment, endpointStatus: action.endpointStatus, remainingWork: action.remainingWork });
          if (completionJudgeSpec(task)) {
            phase = "completion_judge";
            if (!completionJudge) throw new Error("Pinned completion judge is unavailable.");
            const evidence = await abortable(signal, () => this.tasks.completionJudgeEvidence(id, { signal }));
            const judgeInput = { ...evidence, ...(observation.screenshot === undefined ? {} : { screenshot: observation.screenshot }), actorFinish: action };
            const evidenceEvent = await this.tasks.actorEvent(id, "actor_completion_evidence", {
              actorActionEventId: intent.id, observationEventId: observed.id, judge: structuredClone(completionJudgeSpec(task)), evidence,
              input: judgeInput, inputDigest: setupDigest(judgeInput), evidenceContract: completionJudgeSpec(task).evidenceContract?.id ?? COMPLETION_JUDGE_EVIDENCE_CONTRACT.id,
            });
            signal.throwIfAborted();
            const result = await abortable(signal, () => completionJudge.evaluate(judgeInput, signal));
            signal.throwIfAborted();
            const { usage: judgeUsage, ...assessment } = result ?? {};
            validateCompletionAssessment(assessment);
            const judgment = await this.tasks.actorEvent(id, "actor_completion_judgment", {
              actorActionEventId: intent.id, observationEventId: observed.id, evidenceEventId: evidenceEvent.id, judge: structuredClone(completionJudgeSpec(task)),
              verdict: result.verdict, evidenceExplanation: result.evidenceExplanation, continuationHint: result.continuationHint, usage: judgeUsage ?? null,
            });
            signal.throwIfAborted();
            if (result.verdict !== "complete" && !participantMayStopIncomplete(task, action)) {
              if (this.tasks.get(id).completions >= this.tasks.get(id).maxCompletions) {
                await this.tasks.finish(id, { reason: "budget_exhausted" }, { signal });
                return;
              }
              completionJudgeFeedback = result.continuationHint;
              judgeInteractionRequired = true;
              continue;
            }
            await this.tasks.finish(id, { reason: participantMayStopIncomplete(task, action) ? action.reason : "endpoint_reached", actorActionEventId: intent.id, completionJudgeEventId: judgment.id }, { signal });
          } else await this.tasks.finish(id, { reason: action.reason, actorActionEventId: intent.id }, { signal });
          return;
        }
        if (current.completions >= current.maxCompletions && action.kind === "next_step") {
          await this.tasks.finish(id, { reason: "budget_exhausted" }, { signal }); return;
        }
        phase = "act";
        if (action.kind === "next_step") { await this.tasks.nextStep(id, { signal }); signal.throwIfAborted(); await browser.nextStep(); }
        else {
          try { await browser.act(action, { actionEventId: intent.id, observationEventId: observed.id }); }
          catch (error) {
            // Only the browser's own checks before click/fill/select certify no
            // dispatch. Playwright failures and product-write errors are ambiguous.
            if (!["click", "fill", "select"].includes(action.kind) || error.actionDispatched !== false
              || !["actor_control_stale", "actor_control_unavailable"].includes(error.code)) throw error;
            const retryAllowed = !controlRepairPending && actionsUsed < task.actor.maxActions;
            await this.tasks.actorEvent(id, "actor_action_failed", { actionEventId: intent.id, actionDispatched: false,
              category: actorFailure(error).category, retryAllowed, message: "Observed control unavailable before dispatch. No action was executed." });
            if (!retryAllowed) throw error;
            controlRepairPending = true;
            continue;
          }
        }
        controlRepairPending = false;
        judgeInteractionRequired = false;
        await this.tasks.actorEvent(id, "actor_action_completed", { actionEventId: intent.id });
      }

    } catch (error) {
      if (this.tasks.get(id).status === "active") await this.tasks.actorEvent(id, "actor_error", { ...actorFailure(error, { cancelled: cancellation.aborted, timedOut: signal.aborted && !cancellation.aborted }), phase });
      await this.tasks.interruptActor(id, cancellation.aborted ? "actor_cancelled" : signal.aborted ? "actor_timeout" : "actor_failed");
    } finally {
      try { await browser?.close(); } finally { await actor?.close(); }
    }
  }
  async stop(id) {
    const run = this.running.get(id);
    if (!run) return;
    run.controller.abort();
    await run.done;
  }
  async close() { await Promise.all([...this.running.keys()].map((id) => this.stop(id))); }
}

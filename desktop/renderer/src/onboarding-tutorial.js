import {
  ONBOARDING_TUTORIAL_PROMPT,
  createOnboardingTutorialState,
  reduceOnboardingTutorial,
} from "./onboarding-tutorial-state.js";

let sharedController = null;

const COPY = Object.freeze({
  "initial-composer": {
    title: "Start a thread",
    body: "Edit the question or send it as written.",
  },
  "select-node": {
    title: "Select a node",
    body: "Open this node to see its details.",
  },
  "use-action": {
    title: "Use an action",
    body: "Select this action to continue exploring.",
  },
  "write-follow-up": {
    title: "Ask a follow-up",
    body: "Write a question about what you explored, then send it.",
  },
  complete: {
    title: "Tutorial complete.",
    body: "",
  },
});

const GRAPH_SETTLE_FRAMES = 60;

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function escapeSelector(value) {
  const string = String(value);
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(string)
    : string.replace(/["\\]/g, "\\$&");
}

function tutorialAnchorSelector(state) {
  if (state.phase === "initial-composer") return ".new-composer";
  if (state.phase === "select-node") return `[data-node="${escapeSelector(state.target.nodeId)}"]`;
  if (state.phase === "use-action") return `[data-action-id="${escapeSelector(state.target.actionId)}"]`;
  if (state.phase === "write-follow-up" || state.phase === "complete") return "#threadComposer";
  return null;
}

function invokedActionIds(appState, interactionId) {
  return [
    ...(appState.actionInvocations || []),
    ...(appState.pendingActionInvocations || []),
  ].filter((invocation) => sameId(invocation.sourceInteractionId, interactionId))
    .map((invocation) => invocation.actionId);
}

export function createOnboardingTutorialController({
  document: tutorialDocument = document,
  window: tutorialWindow = window,
  lifecycle,
  getAppState,
  getViewState,
  openNewThread,
}) {
  if (!lifecycle || typeof getAppState !== "function" || typeof getViewState !== "function") {
    throw new TypeError("Onboarding tutorial requires lifecycle and product state dependencies.");
  }
  if (typeof openNewThread !== "function") {
    throw new TypeError("Onboarding tutorial requires the ordinary New Thread flow.");
  }

  let active = false;
  let tutorial = null;
  let coachmark = null;
  let linkedTarget = null;
  let positionFrame = null;
  let graphSettleFramesRemaining = 0;
  let focusFrame = null;
  let completionFocused = false;

  function removeDescription(target) {
    if (!target) return;
    const ids = (target.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((id) => id && id !== "onboardingTutorialCopy");
    if (ids.length) target.setAttribute("aria-describedby", ids.join(" "));
    else target.removeAttribute("aria-describedby");
    target.classList.remove("tutorial-target");
  }

  function linkTarget(target) {
    if (linkedTarget === target) return;
    removeDescription(linkedTarget);
    linkedTarget = target;
    if (!target) return;
    const ids = new Set((target.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    ids.add("onboardingTutorialCopy");
    target.setAttribute("aria-describedby", [...ids].join(" "));
    target.classList.add("tutorial-target");
  }

  function stopPositioning() {
    if (positionFrame != null) tutorialWindow.cancelAnimationFrame(positionFrame);
    positionFrame = null;
  }

  function schedulePositioning() {
    if (!active || positionFrame != null) return;
    positionFrame = tutorialWindow.requestAnimationFrame(positionCoachmark);
  }

  function positionCoachmark() {
    positionFrame = null;
    if (!active || !coachmark || !tutorial) return;
    const selector = tutorialAnchorSelector(tutorial);
    const target = selector ? tutorialDocument.querySelector(selector) : null;
    linkTarget(target);
    if (!target || !target.isConnected) {
      coachmark.hidden = true;
    } else {
      coachmark.hidden = false;
      const targetRect = target.getBoundingClientRect();
      const coachRect = coachmark.getBoundingClientRect();
      const margin = 10;
      const viewportWidth = tutorialWindow.innerWidth;
      const viewportHeight = tutorialWindow.innerHeight;
      const below = targetRect.bottom + margin;
      const above = targetRect.top - coachRect.height - margin;
      const top = below + coachRect.height <= viewportHeight - margin
        ? below
        : Math.max(margin, above);
      const centered = targetRect.left + targetRect.width / 2 - coachRect.width / 2;
      const left = Math.min(
        Math.max(margin, centered),
        Math.max(margin, viewportWidth - coachRect.width - margin),
      );
      coachmark.style.left = `${Math.round(left)}px`;
      coachmark.style.top = `${Math.round(top)}px`;
    }
    if (tutorial.phase === "select-node" && graphSettleFramesRemaining > 0) {
      graphSettleFramesRemaining -= 1;
      schedulePositioning();
    }
  }

  const repositionForViewportChange = () => schedulePositioning();
  tutorialWindow.addEventListener?.("resize", repositionForViewportChange);
  tutorialDocument.addEventListener?.("scroll", repositionForViewportChange, true);

  function ensureCoachmark() {
    if (coachmark) return coachmark;
    coachmark = tutorialDocument.createElement("section");
    coachmark.className = "tutorial-coachmark";
    coachmark.setAttribute("role", "region");
    coachmark.setAttribute("aria-label", "Tutorial");
    coachmark.innerHTML = `
      <div id="onboardingTutorialCopy" role="status" aria-live="polite">
        <h2></h2>
        <p></p>
      </div>
      <div class="tutorial-coachmark-actions">
        <button type="button" class="tutorial-skip">Skip tutorial</button>
        <button type="button" class="tutorial-done hidden">Done</button>
      </div>`;
    coachmark.querySelector(".tutorial-skip").onclick = () => void dismiss("skip");
    coachmark.querySelector(".tutorial-done").onclick = hide;
    tutorialDocument.body.append(coachmark);
    return coachmark;
  }

  function hide() {
    active = false;
    stopPositioning();
    if (focusFrame != null) tutorialWindow.cancelAnimationFrame(focusFrame);
    focusFrame = null;
    linkTarget(null);
    coachmark?.remove();
    coachmark = null;
    tutorial = null;
    completionFocused = false;
    graphSettleFramesRemaining = 0;
  }

  async function dismiss(eventType = "leave") {
    if (!active || !tutorial) return;
    tutorial = reduceOnboardingTutorial(tutorial, { type: eventType });
    try {
      await lifecycle.dismiss();
    } finally {
      hide();
    }
  }

  function render() {
    if (!active || !tutorial) return;
    if (tutorial.phase === "dismissed") {
      hide();
      return;
    }
    const copy = COPY[tutorial.phase];
    if (!copy) {
      stopPositioning();
      coachmark?.setAttribute("hidden", "");
      linkTarget(null);
      return;
    }
    const element = ensureCoachmark();
    element.querySelector("h2").textContent = copy.title;
    const paragraph = element.querySelector("p");
    paragraph.textContent = copy.body;
    paragraph.classList.toggle("hidden", !copy.body);
    const complete = tutorial.phase === "complete";
    element.querySelector(".tutorial-skip").classList.toggle("hidden", complete);
    const done = element.querySelector(".tutorial-done");
    done.classList.toggle("hidden", !complete);
    if (complete && !completionFocused) {
      completionFocused = true;
      focusFrame = tutorialWindow.requestAnimationFrame(() => {
        focusFrame = null;
        done.focus({ preventScroll: true });
      });
    }
    stopPositioning();
    graphSettleFramesRemaining = tutorial.phase === "select-node" ? GRAPH_SETTLE_FRAMES : 0;
    positionCoachmark();
    if (tutorial.phase !== "select-node") schedulePositioning();
  }

  async function start(source, context = null) {
    if (active) await dismiss("leave");
    const result = source === "automatic"
      ? await lifecycle.beginAutomatic(context)
      : await lifecycle.beginManual();
    if (!result?.started) return false;
    active = true;
    tutorial = createOnboardingTutorialState();
    completionFocused = false;
    try {
      await openNewThread({ prompt: ONBOARDING_TUTORIAL_PROMPT, source });
    } catch (error) {
      try {
        await lifecycle.dismiss();
      } finally {
        hide();
      }
      throw error;
    }
    render();
    return true;
  }

  async function maybeStartAutomatic({ providerConnected, threadCount }) {
    if (active) return false;
    const context = {
      surface: "product",
      providerConnected: Boolean(providerConnected),
      threadCount,
    };
    const current = await lifecycle.read(context);
    if (!current.automaticEligible) return false;
    return start("automatic", context);
  }

  function dispatch(event) {
    if (!active || !tutorial) return tutorial;
    tutorial = reduceOnboardingTutorial(tutorial, event);
    if (tutorial.phase === "dismissed") {
      void lifecycle.dismiss();
      hide();
      return null;
    }
    render();
    return tutorial;
  }

  function syncWorkspace() {
    if (active && !presentationMatchesTutorial()) {
      void dismiss("leave");
      return;
    }
    if (!active || tutorial?.phase !== "awaiting-accepted-response") {
      if (active) render();
      return;
    }
    const appState = getAppState();
    const viewState = getViewState();
    if (!sameId(viewState.currentThreadId, tutorial.threadId)) return;
    const interaction = (appState.interactions || []).find((candidate) => (
      sameId(candidate.threadId, tutorial.threadId)
      && sameId(candidate.id, tutorial.interactionId)
    ));
    if (!interaction) return;
    if (["failed", "cancelled", "stopped"].includes(interaction.completionStatus)) {
      dispatch({
        type: "response-terminal",
        threadId: tutorial.threadId,
        interactionId: tutorial.interactionId,
        status: interaction.completionStatus,
      });
      return;
    }
    if (interaction.completionStatus !== "accepted") return;
    const layer = interaction.completionOutput?.rootLayer;
    if (!layer) return;
    dispatch({
      type: "response-accepted",
      threadId: tutorial.threadId,
      interactionId: tutorial.interactionId,
      layer,
      invokedActionIds: invokedActionIds(appState, tutorial.interactionId),
    });
  }

  function presentationMatchesTutorial() {
    if (!active || !tutorial) return true;
    const view = getViewState();
    if (tutorial.phase === "initial-composer") return view.mainView === "new";
    if (view.mainView !== "thread" || !sameId(view.currentThreadId, tutorial.threadId)) {
      return false;
    }
    if (tutorial.phase === "complete") return true;
    return view.currentInteractionId == null
      || sameId(view.currentInteractionId, tutorial.interactionId);
  }

  async function followupSubmitted({ threadId, interactionId }) {
    if (!active || !tutorial) return false;
    const next = reduceOnboardingTutorial(tutorial, {
      type: "followup-submitted",
      threadId,
      interactionId,
    });
    if (next.phase !== "complete") return false;
    tutorial = next;
    try {
      await lifecycle.complete();
    } finally {
      render();
    }
    return true;
  }

  function presentationChanged() {
    if (!active || !tutorial) return;
    if (!presentationMatchesTutorial()) void dismiss("leave");
  }

  function actionSucceeded(event) {
    if (!active || !tutorial) return null;
    const expectedActionId = tutorial.phase === "use-action" ? tutorial.target?.actionId : null;
    if (expectedActionId != null && !sameId(expectedActionId, event.actionId)) {
      void dismiss("leave");
      return null;
    }
    return dispatch({ type: "action-succeeded", ...event });
  }

  return Object.freeze({
    maybeStartAutomatic,
    startManual: () => start("manual"),
    threadCreated: ({ threadId, interactionId }) => dispatch({
      type: "thread-created",
      threadId,
      interactionId,
    }),
    nodeSelected: ({ threadId, interactionId, nodeId }) => dispatch({
      type: "node-selected",
      threadId,
      interactionId,
      nodeId,
    }),
    actionSucceeded,
    followupSubmitted,
    syncWorkspace,
    presentationChanged,
    leave: () => dismiss("leave"),
    skip: () => dismiss("skip"),
    dispose() {
      hide();
      tutorialWindow.removeEventListener?.("resize", repositionForViewportChange);
      tutorialDocument.removeEventListener?.("scroll", repositionForViewportChange, true);
    },
    snapshot: () => tutorial,
    isActive: () => active,
  });
}

export function installOnboardingTutorialController(dependencies) {
  sharedController?.dispose();
  sharedController = createOnboardingTutorialController(dependencies);
  return sharedController;
}

export function onboardingTutorialController() {
  return sharedController;
}

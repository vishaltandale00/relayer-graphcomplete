import { controlActivationCompletionFor } from "./control-activation.js";

const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
].join(",");

function finiteRectangle(rect) {
  const value = {
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.max(0, Math.ceil(rect.width)),
    height: Math.max(0, Math.ceil(rect.height)),
  };
  if (!Object.values(value).every(Number.isFinite) || !value.width || !value.height) {
    throw new Error("The review target has no visible capture area.");
  }
  return value;
}

export function isVisibleElement(element, windowObject = window) {
  if (!element?.isConnected || element.hidden) return false;
  if (element.checkVisibility && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const style = windowObject.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.right > 0
    && rect.bottom > 0
    && rect.left < windowObject.innerWidth
    && rect.top < windowObject.innerHeight;
}

export function accessibleControlName(element) {
  return element.getAttribute("aria-label")?.trim()
    || element.getAttribute("title")?.trim()
    || element.textContent?.trim().replace(/\s+/g, " ")
    || element.getAttribute("placeholder")?.trim()
    || "";
}

export function isAccessibleControl(element, windowObject = window) {
  return element?.matches?.(CONTROL_SELECTOR)
    && isVisibleElement(element, windowObject)
    && Boolean(accessibleControlName(element));
}

export function visibleCaptureRegions(root = document, windowObject = window) {
  return [...root.querySelectorAll("[data-review-capture]")]
    .filter((element) => isVisibleElement(element, windowObject))
    .map((element) => ({
      elementRef: element.dataset.reviewCapture,
      name: accessibleControlName(element),
      role: element.getAttribute("role") || "region",
      disabled: false,
      kind: "capture-region",
      actionId: element.dataset.reviewActionId || null,
    }))
    .filter((region) => Boolean(region.elementRef && region.name));
}

function nextFrame(windowObject) {
  return new Promise((resolve) => windowObject.requestAnimationFrame(() => resolve()));
}

function validateMode(mode) {
  if (mode !== "visible" && mode !== "full") {
    throw new Error("Screenshot mode must be visible or full.");
  }
}

function logicalPresentationKey(presentation) {
  return JSON.stringify({
    threadId: presentation?.threadId ?? null,
    turnId: presentation?.turnId ?? null,
    layerId: presentation?.layerId ?? null,
    selectedNodeId: presentation?.selectedNodeId ?? null,
    navigationPath: Array.isArray(presentation?.navigationPath)
      ? presentation.navigationPath.map((entry) => [
        String(entry.layerId),
        entry.viaActionId == null ? null : String(entry.viaActionId),
      ])
      : [],
  });
}

function canonicalNavigationPath(path) {
  return (path || []).map((entry) => ({
    layerId: String(entry.layerId),
    viaActionId: entry.viaActionId == null ? null : String(entry.viaActionId),
  }));
}

function activatedActionForPath(path) {
  return [...path].reverse().find((entry) => entry.viaActionId !== null)?.viaActionId ?? null;
}

function presentationIsInternallyConsistent(presentation) {
  if (presentation?.threadId == null || presentation?.turnId == null) return false;
  if (!Array.isArray(presentation.navigationPath)) return false;
  if (presentation.layerId == null) {
    return presentation.navigationPath.length === 0 && presentation.selectedNodeId == null;
  }
  return presentation.navigationPath.length > 0
    && String(presentation.navigationPath.at(-1)?.layerId) === String(presentation.layerId);
}

export function createReviewPresentationAdapter({
  executionId,
  getPresentationState,
  navigateHistory,
  setInputOperatorCommitted = null,
  root = document,
  windowObject = window,
}) {
  if (!executionId) throw new Error("A review presentation adapter requires an execution ID.");
  if (typeof navigateHistory !== "function") {
    throw new Error("A review presentation adapter requires workspace history navigation.");
  }
  let automaticReference = 0;
  const automaticReferences = new WeakMap();
  const referencedElements = new Map();
  let capture = null;
  let activatedActionId = null;
  let navigationPath = [];

  function referenceFor(element) {
    const explicit = element.dataset.reviewRef;
    if (explicit) return explicit;
    let reference = automaticReferences.get(element);
    if (!reference) {
      reference = `control-${++automaticReference}`;
      automaticReferences.set(element, reference);
    }
    return reference;
  }

  function controls() {
    referencedElements.clear();
    return [...root.querySelectorAll(CONTROL_SELECTOR)]
      .filter((element) => isAccessibleControl(element, windowObject))
      .map((element) => {
        const elementRef = referenceFor(element);
        referencedElements.set(elementRef, element);
        return {
          elementRef,
          name: accessibleControlName(element),
          role: element.getAttribute("role") || element.localName,
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
          kind: element.dataset.reviewKind || "control",
          actionId: element.dataset.reviewActionId || null,
        };
      });
  }

  function snapshot() {
    const presentation = getPresentationState();
    if (Array.isArray(presentation.navigationPath)) {
      navigationPath = canonicalNavigationPath(presentation.navigationPath);
    } else if (!navigationPath.length && presentation.layerId) {
      navigationPath = [{ layerId: String(presentation.layerId), viaActionId: null }];
    }
    if (Object.hasOwn(presentation, "activatedActionId")) {
      activatedActionId = presentation.activatedActionId ?? null;
    }
    return {
      executionId,
      threadId: presentation.threadId ?? null,
      threadRevision: presentation.threadRevision ?? null,
      turnId: presentation.turnId ?? null,
      layerId: presentation.layerId ?? null,
      selectedNodeId: presentation.selectedNodeId ?? null,
      activatedActionId,
      navigationPath: [...navigationPath],
      viewport: {
        width: windowObject.innerWidth,
        height: windowObject.innerHeight,
        deviceScaleFactor: windowObject.devicePixelRatio,
      },
      controls: [...controls(), ...visibleCaptureRegions(root, windowObject)],
    };
  }

  function resolveTarget(target) {
    if (target?.kind === "viewport") return null;
    if (target?.kind !== "element" || typeof target.elementRef !== "string") {
      throw new Error("Screenshot target must identify the viewport or one visible element.");
    }
    controls();
    const control = referencedElements.get(target.elementRef);
    const captureTarget = [...root.querySelectorAll("[data-review-capture]")]
      .find((element) => element.dataset.reviewCapture === target.elementRef);
    const element = control || captureTarget;
    if (!element) throw new Error(`Unknown review target: ${target.elementRef}`);
    if (!isVisibleElement(element, windowObject)) throw new Error(`Review target is not visible: ${target.elementRef}`);
    return element;
  }

  async function capturePlan({ target, mode }) {
    validateMode(mode);
    if (capture) throw new Error("A review capture is already active.");
    // Selection state is published before the inspector and graph selection have
    // necessarily reached Chromium's painted frame. Capturing immediately can
    // therefore bind new metadata to pixels from the previously selected node.
    await nextFrame(windowObject);
    await nextFrame(windowObject);
    const element = resolveTarget(target);
    if (!element) {
      if (mode === "full") throw new Error("Full capture requires a visible element target.");
      return {
        target,
        mode,
        clip: { x: 0, y: 0, width: windowObject.innerWidth, height: windowObject.innerHeight },
        tiles: [{ index: 0, row: 0, column: 0, scrollX: 0, scrollY: 0 }],
      };
    }
    const clip = finiteRectangle(element.getBoundingClientRect());
    const fullWidth = Math.max(element.clientWidth, element.scrollWidth);
    const fullHeight = Math.max(element.clientHeight, element.scrollHeight);
    const tileWidth = Math.max(1, element.clientWidth);
    const tileHeight = Math.max(1, element.clientHeight);
    const columns = mode === "full" ? Math.ceil(fullWidth / tileWidth) : 1;
    const rows = mode === "full" ? Math.ceil(fullHeight / tileHeight) : 1;
    const tiles = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        tiles.push({
          index: tiles.length,
          row,
          column,
          scrollX: Math.min(column * tileWidth, Math.max(0, fullWidth - tileWidth)),
          scrollY: Math.min(row * tileHeight, Math.max(0, fullHeight - tileHeight)),
        });
      }
    }
    capture = {
      element,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      clip,
    };
    return { target, mode, clip, fullWidth, fullHeight, tileWidth, tileHeight, tiles };
  }

  async function prepareCaptureTile({ index, scrollX, scrollY }) {
    if (!capture) throw new Error("No review capture is active.");
    capture.element.scrollLeft = scrollX;
    capture.element.scrollTop = scrollY;
    await nextFrame(windowObject);
    await nextFrame(windowObject);
    return { index, clip: finiteRectangle(capture.element.getBoundingClientRect()) };
  }

  async function restoreCapture() {
    if (!capture) return;
    capture.element.scrollLeft = capture.scrollLeft;
    capture.element.scrollTop = capture.scrollTop;
    capture = null;
    await nextFrame(windowObject);
  }

  async function activate({ elementRef, operation }) {
    if (operation !== "activate") throw new Error("The review interact tool supports activate only.");
    controls();
    const element = referencedElements.get(elementRef);
    if (!element || !isAccessibleControl(element, windowObject)) {
      throw new Error(`Review control is unknown, inaccessible, or no longer visible: ${elementRef}`);
    }
    if (element.disabled || element.getAttribute("aria-disabled") === "true") {
      throw new Error(`Review control is disabled: ${elementRef}`);
    }
    const kind = element.dataset.reviewKind || "control";
    const before = getPresentationState();
    const actionId = element.dataset.reviewActionId || null;
    const breadcrumbPathIndex = Number(element.dataset.reviewPathIndex);
    element.click();
    if (kind === "history") {
      const completion = controlActivationCompletionFor(element);
      if (!completion) {
        throw new Error(`Review history control did not expose navigation completion: ${elementRef}`);
      }
      await completion;
    }
    let settled = false;
    const frameLimit = kind === "history" ? 1 : 120;
    for (let frame = 0; frame < frameLimit; frame++) {
      await nextFrame(windowObject);
      const current = getPresentationState();
      settled = kind === "node" ? current.selectedNodeId !== before.selectedNodeId
        : kind === "navigate-action" ? logicalPresentationKey(current) !== logicalPresentationKey(before)
        : kind === "layer-navigation" ? (
          current.layerId !== before.layerId
          || current.selectedNodeId !== before.selectedNodeId
        )
        : kind === "turn" ? current.turnId !== before.turnId
          : kind === "thread" ? (
            current.threadId !== before.threadId
            && presentationIsInternallyConsistent(current)
          )
            : kind === "history" ? logicalPresentationKey(current) !== logicalPresentationKey(before)
              : true;
      if (settled) break;
    }
    if (!settled) throw new Error(`Review control did not change the expected presentation: ${elementRef}`);
    const after = getPresentationState();
    if (Array.isArray(after.navigationPath)) {
      navigationPath = canonicalNavigationPath(after.navigationPath);
    } else if (actionId && kind === "navigate-action" && after.layerId !== before.layerId) {
      navigationPath.push({ layerId: after.layerId, viaActionId: actionId });
    } else if (kind === "layer-navigation") {
      navigationPath = Number.isInteger(breadcrumbPathIndex)
        ? navigationPath.slice(0, breadcrumbPathIndex + 1)
        : after.layerId ? [{ layerId: after.layerId, viaActionId: null }] : [];
    } else if (["turn", "thread"].includes(kind)) {
      navigationPath = after.layerId ? [{ layerId: after.layerId, viaActionId: null }] : [];
    }
    activatedActionId = ["history", "layer-navigation"].includes(kind)
      ? activatedActionForPath(navigationPath)
      : kind === "navigate-action" ? String(actionId)
        : null;
    return snapshot();
  }

  async function history({ delta } = {}) {
    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw new Error("History delta must be a non-zero signed integer.");
    }
    const committed = await navigateHistory(delta);
    if (Array.isArray(committed?.navigationPath)) {
      navigationPath = canonicalNavigationPath(committed.navigationPath);
      activatedActionId = activatedActionForPath(navigationPath);
    }
    if (committed && Object.hasOwn(committed, "activatedActionId")) {
      activatedActionId = committed.activatedActionId ?? null;
    }
    await nextFrame(windowObject);
    return snapshot();
  }

  async function updateInputOperatorState({ committed } = {}) {
    if (typeof setInputOperatorCommitted !== "function") {
      throw new Error("This review has no input operator presentation capability.");
    }
    setInputOperatorCommitted(committed === true);
    await nextFrame(windowObject);
    return snapshot();
  }

  return Object.freeze({
    snapshot,
    capturePlan,
    prepareCaptureTile,
    restoreCapture,
    activate,
    history,
    updateInputOperatorState,
  });
}

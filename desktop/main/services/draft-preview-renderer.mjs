import { createArtifactPreviewCapture } from "./artifact-viewer.mjs";
import { createIsolatedPageCapture } from "./isolated-page-capture.mjs";

/**
 * In-app frames in the default 1420×900 desktop window, measured from the
 * production renderer: the graph pane with Node Details closed, and the Node
 * Details panel. `npm run evidence:agent-preview` re-measures them.
 */
export const DRAFT_PREVIEW_FRAMES = Object.freeze({
  layer: Object.freeze({ width: 1164, height: 703 }),
  node: Object.freeze({ width: 576, height: 844 }),
});
export const DRAFT_PREVIEW_START_VIEWPORT = Object.freeze({ width: 1420, height: 900 });
/** Stays below the graph server's 2 MiB image cap. */
export const DRAFT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const DRAFT_PREVIEW_TEMPLATE = "src/draft-preview/template.js";

export function draftPreviewFrame(snapshot) {
  const frame = DRAFT_PREVIEW_FRAMES[snapshot?.target?.kind];
  if (frame === undefined) throw new TypeError("Draft preview target is invalid.");
  return frame;
}

/**
 * The preview page has no sidebar or composer, so resize its viewport until
 * the target's on-page rectangle equals the in-app frame, then apply Fit.
 * `call(step)` runs a step of the page's `window.relayerDraftPreview`.
 */
export async function frameDraftPreview({ snapshot, call, resize }) {
  const want = draftPreviewFrame(snapshot);
  let viewport = { ...DRAFT_PREVIEW_START_VIEWPORT };
  let rect = await call("frame");
  // A panel can be a fraction of the viewport, so step each dimension by the
  // observed ratio of frame change to viewport change (a secant step).
  const slope = { width: 1, height: 1 };
  for (let attempt = 0; attempt < 8 && (rect.width !== want.width || rect.height !== want.height); attempt += 1) {
    const next = { ...viewport };
    for (const axis of ["width", "height"]) {
      if (rect[axis] !== want[axis]) next[axis] = Math.max(320, Math.round(viewport[axis] + (want[axis] - rect[axis]) / slope[axis]));
    }
    await resize(next);
    const measured = await call("frame");
    for (const axis of ["width", "height"]) {
      const moved = next[axis] - viewport[axis];
      if (moved !== 0 && measured[axis] !== rect[axis]) slope[axis] = (measured[axis] - rect[axis]) / moved;
    }
    viewport = next;
    rect = measured;
  }
  rect = await call("settle");
  if (rect.width !== want.width || rect.height !== want.height) {
    throw new Error(`Draft preview frame is ${rect.width}×${rect.height}, expected ${want.width}×${want.height}.`);
  }
  return rect;
}

/** The in-page call a host driver evaluates for one preview step. */
export function draftPreviewStepScript(step) {
  if (step !== "frame" && step !== "settle") throw new TypeError("Unknown draft preview step.");
  return `(async()=>{
    const until=Date.now()+10000;
    while(!window.relayerDraftPreview){if(Date.now()>until)throw new Error('Draft preview did not boot');await new Promise(r=>setTimeout(r,25));}
    if(window.relayerDraftPreview.error)throw new Error(window.relayerDraftPreview.error);
    return window.relayerDraftPreview.${step}();
  })()`;
}

/** The artifact an artifact layer's preview shows, or null for a graph layer (PRD 6.6). */
export function draftPreviewArtifact(snapshot) {
  if (snapshot?.target?.kind !== "layer" || snapshot.layer?.renderer !== "artifact") return null;
  const artifact = snapshot.nodes?.[0]?.artifact;
  return artifact && typeof artifact === "object" ? artifact : null;
}

/**
 * Desktop render bridge (PRD §11.10): renders the agent's draft in an isolated
 * hidden window, in the user's light or dark theme at render time. An artifact
 * layer shows the artifact itself, as the viewer will (ART-005).
 */
export function createElectronDraftPreviewRenderer({ BrowserWindow, session, rendererDirectory, getTheme }) {
  const capture = createIsolatedPageCapture({
    BrowserWindow,
    session,
    rendererDirectory,
    partition: "draft-preview-capture",
  });
  const captureArtifact = createArtifactPreviewCapture({ BrowserWindow, session, rendererDirectory, maxBytes: DRAFT_PREVIEW_MAX_BYTES });
  return {
    async render({ snapshot, workingDirectory }) {
      const artifact = draftPreviewArtifact(snapshot);
      if (artifact) return captureArtifact({ artifact, folder: workingDirectory, size: DRAFT_PREVIEW_FRAMES.layer });
      const frame = draftPreviewFrame(snapshot);
      const theme = getTheme();
      return capture({
        template: DRAFT_PREVIEW_TEMPLATE,
        render: ({ renderDraftPreviewTemplate }, assetBase) => renderDraftPreviewTemplate({ snapshot, theme, assetBase }),
        size: DRAFT_PREVIEW_START_VIEWPORT,
        maxBytes: DRAFT_PREVIEW_MAX_BYTES,
        prepare: async (window) => ({
          clip: await frameDraftPreview({
            snapshot,
            call: (step) => window.webContents.executeJavaScript(draftPreviewStepScript(step)),
            resize: async ({ width, height }) => window.setContentSize(width, height),
          }),
          output: frame,
        }),
      });
    },
  };
}

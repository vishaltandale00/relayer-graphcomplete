import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SAVED_THREAD_TEXT = "keep this unsent follow up with the saved thread";
const NEW_THREAD_HEADING = "what are we working on";
const NEW_THREAD_PROMPT = "ask relayer to investigate design or build something";

function normalizedCaptureText(value) {
  return String(value ?? "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function classifyDesktopCaptureText(value) {
  const text = normalizedCaptureText(value);
  const savedThread = text.includes(SAVED_THREAD_TEXT);
  const emptyNewThread = text.includes(NEW_THREAD_HEADING)
    && text.includes(NEW_THREAD_PROMPT);
  const savedThreadHint = text.includes("keep this unsent follow up")
    || text.includes("with the saved thread");
  const newThreadHint = text.includes(NEW_THREAD_HEADING)
    || text.includes(NEW_THREAD_PROMPT);
  if (savedThreadHint && newThreadHint) return "unknown";
  if (savedThread && !newThreadHint) return "saved-thread";
  if (emptyNewThread && !savedThreadHint) return "empty-new-thread";
  return "unknown";
}

export function capturedStateRun(frames, state, { afterIndex = -1, beforeIndex = frames.length - 1 } = {}) {
  let run = null;
  let latest = null;
  for (let index = Math.max(0, afterIndex + 1); index <= Math.min(beforeIndex, frames.length - 1); index += 1) {
    const frame = frames[index];
    if (frame.state === state) {
      if (!run) {
        run = { state, firstIndex: index, firstAtMs: frame.capturedAtMs };
      }
      latest = {
        ...run,
        lastIndex: index,
        lastAtMs: frame.capturedAtMs,
        durationMs: frame.capturedAtMs - run.firstAtMs,
      };
    } else {
      run = null;
    }
  }
  return latest;
}

export function capturedStateMeetsReadableHold(frames, state, minimumMs, options) {
  const run = capturedStateRun(frames, state, options);
  return run && run.durationMs >= minimumMs ? run : null;
}

export async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

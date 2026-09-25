import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PROMISES,
  ProviderSettingsWorld,
  projectModelState,
} from "./support/provider-settings-trace-adapter.mjs";

// Scenario traces rendered from models/tla/ProviderSettings.tla (see
// models/tla/README.md). Each step replays against the real provider service
// and IPC handlers. The real state must equal the model's state after every
// step, and the scenario's promises must hold on it. A mismatch means the
// code and the model disagree; a broken promise is a bug in both.
const traceDirectory = join(import.meta.dirname, "..", "models", "tla", "traces");
const traces = readdirSync(traceDirectory)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(traceDirectory, file), "utf8")))
  .filter((trace) => trace.module === "ProviderSettings");

const describeStep = (action) => (action ? action.join(" ") : "initial state");

describe("ProviderSettings traces replay against the desktop provider service", () => {
  it("has traces to replay", () => {
    expect(traces.length).toBeGreaterThan(0);
  });

  for (const trace of traces) {
    it(`${trace.scenario}: ${trace.summary}`, async () => {
      const world = new ProviderSettingsWorld();
      await world.service.list();
      for (const [index, { action, state }] of trace.steps.entries()) {
        if (action) await world.apply(action);
        const real = world.observe();
        const where = `step ${index} (${describeStep(action)})`;
        expect(real, `${where}: real state diverges from the model`).toEqual(projectModelState(state));
        for (const promise of trace.promises) {
          expect(PROMISES[promise](real), `${where}: ${promise} is broken`).toBe(true);
        }
      }
    });
  }
});

import { afterEach, expect, it, vi } from "vitest";
import { RelayerGraphClient } from "../src/index.js";
afterEach(() => vi.unstubAllGlobals());
const graph = () => new RelayerGraphClient({ url: "http://graph.test", token: "scoped", nodeId: 1 });
const page = (lifecycle = "active", answers: unknown[] = []) => ({ current: { lifecycle }, answers, nextSequence: 4, currentAnswers: [], eligibleActionIds: [] });
it("reads scoped cursor pages, stops on answers or terminal state, and never writes", async () => {
  const fetch = vi.fn(async () => Response.json(page("active", [{ sequence: 4 }])));
  vi.stubGlobal("fetch", fetch);
  expect((await graph().waitForLiveAnswers(3)).nextSequence).toBe(4);
  expect(fetch.mock.calls[0]).toMatchObject(["http://graph.test/api/graph/live-answers?afterSequence=3", { headers: { authorization: "Bearer scoped" } }]);
  fetch.mockImplementation(async () => Response.json(page("stopped")));
  expect((await graph().waitForLiveAnswers(4)).current.lifecycle).toBe("stopped");
  for (const invalid of [-1, 0.5, NaN]) await expect(graph().getLiveAnswers(invalid)).rejects.toThrow("cursor");
});
it("returns an empty page at a polling deadline and cancels in-flight reads", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(page())));
  expect((await graph().waitForLiveAnswers(0, 0)).answers).toEqual([]);
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => { entered(); init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); })));
  const controller = new AbortController();
  const result = graph().waitForLiveAnswers(0, 30000, controller.signal);
  await pending;
  const reason = new Error("provider stopped"); controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  await expect(graph().waitForLiveAnswers(0, 10)).rejects.toMatchObject({ name: "TimeoutError" });
});

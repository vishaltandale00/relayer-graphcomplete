import { afterEach, describe, expect, it } from "vitest";

import {
  createDeterministicPrimeProviderServer,
  PRIME_EVIDENCE_API_KEY,
  PRIME_EVIDENCE_CHILD_MODEL,
  PRIME_EVIDENCE_ROOT_MODEL,
  requestFacts,
} from "../scripts/prime-evidence/deterministic-openai-server.mjs";

let server;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function request(path, init = {}) {
  return fetch(`${server.endpoint}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${PRIME_EVIDENCE_API_KEY}`, ...init.headers },
  });
}

function completedToolCode(events) {
  const completed = events.split("\n")
    .filter((line) => line.startsWith("data: {") && line.includes('"response.completed"'))
    .map((line) => JSON.parse(line.slice(6)))
    .at(-1);
  return JSON.parse(completed.response.output[0].arguments).code;
}

describe("deterministic Prime OpenAI-compatible provider", () => {
  it("uses the latest interaction identity from a continued Prime session", () => {
    expect(requestFacts({ input: [
      { role: "user", content: "Current interaction node: 47" },
      { role: "user", content: "Current interaction node: 48" },
    ] }).interactionId).toBe(48);
  });

  it("discovers the ordered evidence models through the production adapter endpoint", async () => {
    server = await createDeterministicPrimeProviderServer();
    const response = await request("/models");

    expect(response.status).toBe(200);
    expect((await response.json()).data.map(({ id }) => id)).toEqual([
      PRIME_EVIDENCE_ROOT_MODEL,
      PRIME_EVIDENCE_CHILD_MODEL,
    ]);
    expect(server.observations).toMatchObject([{ method: "GET", pathname: "/v1/models", authorized: true }]);
    expect(JSON.stringify(server.observations)).not.toContain(PRIME_EVIDENCE_API_KEY);
  });

  it("scripts a root IPython graph call and a distinct recursive child without inference", async () => {
    server = await createDeterministicPrimeProviderServer();
    const root = await request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", session_id: "root-session" },
      body: JSON.stringify({
        model: PRIME_EVIDENCE_ROOT_MODEL,
        stream: true,
        input: [
          { role: "developer", content: "General guidance may mention follow-up interactions without changing this request." },
          { role: "user", content: "Current interaction node: 47" },
        ],
      }),
    });
    const rootEvents = await root.text();
    expect(rootEvents).toContain('"name":"ipython"');
    const code = completedToolCode(rootEvents);
    expect(code).toContain('await rlm("deterministic family child');
    expect(code).toContain("await graph.submit(47)");

    const continuation = await request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", session_id: "root-session" },
      body: JSON.stringify({
        model: PRIME_EVIDENCE_ROOT_MODEL,
        stream: true,
        input: [{
          type: "function_call_output",
          output: `${code}\nCurrent interaction node: 47`,
        }],
      }),
    });
    expect(await continuation.text()).toContain("The deterministic Prime graph was submitted.");

    const child = await request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", session_id: "child-session" },
      body: JSON.stringify({
        model: PRIME_EVIDENCE_CHILD_MODEL,
        stream: true,
        input: [{ role: "user", content: "[task from parent] deterministic family child: report the admitted child model" }],
      }),
    });
    expect(await child.text()).toContain("Deterministic child completed with the second family member.");
    expect(server.observations.filter(({ pathname }) => pathname === "/v1/responses").map(({ model, recursionRole }) => [model, recursionRole])).toEqual([
      [PRIME_EVIDENCE_ROOT_MODEL, "root"],
      [PRIME_EVIDENCE_ROOT_MODEL, "root"],
      [PRIME_EVIDENCE_CHILD_MODEL, "child"],
    ]);
  });

  it("requires the exact test credential", async () => {
    server = await createDeterministicPrimeProviderServer();
    const response = await fetch(`${server.endpoint}/models`, { headers: { Authorization: "Bearer wrong" } });
    expect(response.status).toBe(401);
  });
});

import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  completionMetadata,
  productRequest,
} from "../scripts/recursive-live-run-transport.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

describe("recursive live run transport", () => {
  it("authenticates product JSON requests with the loopback session cookie", async () => {
    const origin = await serve((request, response) => {
      expect(request.url).toBe("/api/model-families");
      expect(request.headers.cookie).toBe("relayer_session=session-value");
      expect(request.headers["content-type"]).toBe("application/json");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 41 }));
    });

    await expect(productRequest({
      origin,
      cookie: { name: "relayer_session", value: "session-value" },
    }, "/api/model-families", {
      method: "POST",
      body: JSON.stringify({ name: "Live run models" }),
    })).resolves.toEqual({ id: 41 });
  });

  it("reads completion invocation metadata through graph control authority", async () => {
    const graphUrl = await serve((request, response) => {
      expect(request.headers.authorization).toBe("Bearer graph-control");
      const nodeId = Number(request.url.split("/").at(-1));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ nodeId, invocation: nodeId === 2
        ? { sourceInteractionNodeId: 1, sourceActionId: 7 }
        : null }));
    });

    await expect(completionMetadata({
      graphUrl,
      graphControlToken: "graph-control",
    }, [1, 2])).resolves.toEqual([
      { nodeId: 1, invocation: null },
      { nodeId: 2, invocation: { sourceInteractionNodeId: 1, sourceActionId: 7 } },
    ]);
  });
});

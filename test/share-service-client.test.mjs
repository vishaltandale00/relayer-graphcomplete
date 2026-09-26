import { describe, expect, it, vi } from "vitest";

import { createShareServiceClient } from "../desktop/main/services/share-service-client.mjs";

const attempt = Object.freeze({
  attemptId: "00112233445566778899aabbccddeeff",
  sourceThreadId: "installation:test:thread:42",
  title: "Public title",
  projectName: "Public project",
  byteLength: 17,
  lineCount: 2,
  snapshotSha256: "a".repeat(64),
});

const snapshot = new TextEncoder().encode('{"recordType":"header"}\n{"recordType":"turn"}\n');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

describe("main-only share service client", () => {
  it("reports an already exhausted UTC-day quota before title collection", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      shareId: String(index).padStart(32, "0"),
      createdAt: `2026-09-26T${String(index).padStart(2, "0")}:00:00.000Z`,
    }));
    const client = createShareServiceClient({
      endpoint: "https://share.example.test",
      now: () => Date.parse("2026-09-26T23:30:00.000Z"),
      fetchImpl: async () => response({ items }),
    });

    await expect(client.preflight({ authorization: "Bearer verified-id-token" }))
      .rejects.toMatchObject({
        code: "daily_quota_exhausted",
        resetAt: "2026-09-27T00:00:00.000Z",
        used: 20,
        limit: 20,
      });
  });

  it("reserves, uploads with the signed policy, and finalizes with the same bearer", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/shares") && init.method === "POST") {
        return response({
          status: "reserved",
          shareId: "0123456789abcdef0123456789abcdef",
          attemptId: attempt.attemptId,
          url: "https://share.example.test/t/0123456789abcdef0123456789abcdef",
          maxBytes: 16 * 1024 * 1024,
          expiresAt: "2030-01-01T00:00:00.000Z",
          upload: {
            method: "POST",
            url: "https://objects.example.test/upload",
            key: "staging/v1/0123456789abcdef0123456789abcdef.jsonl",
            expiresAt: "2030-01-01T00:00:00.000Z",
            maxBytes: 16 * 1024 * 1024,
            fields: { key: "staging/v1/0123456789abcdef0123456789abcdef.jsonl", policy: "signed" },
          },
        });
      }
      if (url === "https://objects.example.test/upload") return response({}, 204);
      if (url.endsWith("/finalize") && init.method === "POST") {
        return response({
          status: "created",
          shareId: "0123456789abcdef0123456789abcdef",
          url: "https://share.example.test/t/0123456789abcdef0123456789abcdef",
          title: attempt.title,
          projectName: attempt.projectName,
          createdAt: "2026-09-26T12:00:00.000Z",
          byteLength: snapshot.byteLength,
          lineCount: 2,
          quotaResetAt: "2026-09-27T00:00:00.000Z",
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const assertAuthority = vi.fn(async () => {});
    const client = createShareServiceClient({ endpoint: "https://share.example.test/api", fetchImpl });

    await expect(client.publish({
      authorization: "Bearer verified-id-token",
      assertAuthority,
      attempt,
      snapshotBytes: snapshot,
    })).resolves.toMatchObject({
      url: "https://share.example.test/t/0123456789abcdef0123456789abcdef",
      quotaResetAt: "2026-09-27T00:00:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(assertAuthority).toHaveBeenCalledTimes(3);

    const reserve = calls[0];
    expect(reserve.init.headers).toMatchObject({
      authorization: "Bearer verified-id-token",
      "content-type": "application/json",
      "idempotency-key": attempt.attemptId,
    });
    expect(JSON.parse(reserve.init.body)).toEqual(attempt);

    const upload = calls[1];
    expect(upload.init.headers?.authorization).toBeUndefined();
    expect(upload.init.body).toBeInstanceOf(FormData);
    expect(upload.init.body.get("key")).toBe("staging/v1/0123456789abcdef0123456789abcdef.jsonl");
    expect(upload.init.body.get("file")).toBeInstanceOf(Blob);

    const finalize = calls[2];
    expect(finalize.init.headers).toMatchObject({ authorization: "Bearer verified-id-token" });
    expect(JSON.stringify(upload.init)).not.toContain("Bearer verified-id-token");
  });

  it("maps service failures without exposing response or bearer material", async () => {
    const fetchImpl = vi.fn(async () => response({
      error: "daily_quota_exhausted",
      resetAt: "2026-09-27T00:00:00.000Z",
      used: 20,
      limit: 20,
      debug: "Bearer should-not-escape",
    }, 429));
    const client = createShareServiceClient({ endpoint: "https://share.example.test", fetchImpl });

    await expect(client.publish({
      authorization: "Bearer verified-id-token",
      assertAuthority: async () => {},
      attempt,
      snapshotBytes: snapshot,
    })).rejects.toMatchObject({
      code: "daily_quota_exhausted",
      failureStage: "service",
      resetAt: "2026-09-27T00:00:00.000Z",
      used: 20,
      limit: 20,
    });
    await expect(client.publish({
      authorization: "Bearer verified-id-token",
      assertAuthority: async () => {},
      attempt,
      snapshotBytes: snapshot,
    })).rejects.toSatisfy((error) => {
      expect(error.message).not.toContain("Bearer");
      return true;
    });
  });
});

import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAuth0Verifier,
  createShareService,
  createStaticJwksProvider,
  deriveOwnerHash,
  InMemoryShareObjectStore,
  InMemorySharePageCache,
  InMemoryShareRepository,
  MAX_SNAPSHOT_BYTES,
  SnapshotValidationError,
  validateSnapshotBytes,
  type FinalizeResult,
  type ReserveResult,
  type ShareAttemptInput,
  type ShareServiceError,
} from "../src/index.js";

const NOW = 1_900_000_000_000;
const ISSUER = "https://auth.example.test/";
const CLIENT_ID = "desktop-client";
const INSTALL_URL = "https://app.relayerlabs.ai/desktop/login";
const ASSET_MANIFEST = {
  version: 1 as const,
  assets: {
    shellCss: "assets/commit-abc/viewer.css",
    shellJs: "assets/commit-abc/viewer.js",
  },
};
const SNAPSHOT = new TextEncoder().encode(
  '{"recordType":"header","exportVersion":1}\n{"recordType":"turn","id":"turn:1"}\n',
);

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signingJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function token(subject: string, overrides: Record<string, unknown> = {}): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "share-key" }));
  const payload = base64url(JSON.stringify({
    iss: ISSUER,
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: subject,
    iat: Math.floor(NOW / 1_000) - 60,
    exp: Math.floor(NOW / 1_000) + 3_600,
    ...overrides,
  }));
  const signed = `${header}.${payload}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}

function snapshotInput(attemptId: string, title = "Public title", overrides: Partial<ShareAttemptInput> = {}): ShareAttemptInput {
  const validation = validateSnapshotBytes(SNAPSHOT);
  return {
    attemptId,
    sourceThreadId: "thread:42",
    title,
    projectName: "Public project",
    byteLength: validation.byteLength,
    lineCount: validation.lineCount,
    snapshotSha256: validation.sha256,
    ...overrides,
  };
}

function fixture() {
  let idCounter = 0;
  const now = () => NOW;
  const authenticator = createAuth0Verifier({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    jwks: createStaticJwksProvider([{ ...signingJwk, kid: "share-key", kty: "RSA", alg: "RS256" }]),
    now,
  });
  const repository = new InMemoryShareRepository();
  const objectStore = new InMemoryShareObjectStore(now);
  const pageCache = new InMemorySharePageCache();
  const service = createShareService({
    authenticator,
    repository,
    objectStore,
    pageCache,
    publicOrigin: "https://share.example.test",
    installRedirectUrl: INSTALL_URL,
    assetManifest: ASSET_MANIFEST,
    now,
    randomShareId: () => `${(++idCounter).toString(16).padStart(32, "0")}`,
  });
  return { authenticator, repository, objectStore, pageCache, service };
}

async function identityFor(authenticator: ReturnType<typeof createAuth0Verifier>, subject: string) {
  return authenticator.verifyIdToken(token(subject));
}

async function reserve(fixtureValue: ReturnType<typeof fixture>, identity: Awaited<ReturnType<typeof identityFor>>, input: ShareAttemptInput) {
  return fixtureValue.service.reserve(identity, input);
}

async function publishFixture(
  fixtureValue: ReturnType<typeof fixture>,
  identity: Awaited<ReturnType<typeof identityFor>>,
  input: ShareAttemptInput,
): Promise<{ readonly reservation: ReserveResult; readonly result: FinalizeResult }> {
  const reservation = await reserve(fixtureValue, identity, input);
  await fixtureValue.objectStore.putStaging(reservation.upload!.key, SNAPSHOT);
  const result = await fixtureValue.service.finalize(identity, reservation.shareId);
  return { reservation, result };
}

afterEach(() => {
  // The fixtures have no processes, sockets, or external resources. Keeping
  // this hook makes future adapter replacements explicit at the test seam.
});

describe("share-service Auth0 authority", () => {
  it("verifies the RS256 ID token and stores only a domain-separated owner hash", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|alice");

    expect(identity).toEqual({ ownerHash: deriveOwnerHash("auth0|alice") });
    expect(JSON.stringify(identity)).not.toContain("auth0|alice");
    await expect(current.authenticator.verifyIdToken(token("auth0|alice", { aud: "other-client" })))
      .rejects.toMatchObject({ status: 401, code: "invalid_token" });
    await expect(current.authenticator.verifyBearer("Basic token"))
      .rejects.toMatchObject({ status: 401, code: "invalid_authorization" });
  });

  it("rejects expired, unknown-key, and multi-audience tokens without revealing token details", async () => {
    const current = fixture();
    await expect(current.authenticator.verifyIdToken(token("auth0|alice", { exp: Math.floor(NOW / 1_000) })))
      .rejects.toMatchObject({ status: 401, code: "invalid_token" });
    const unknownKeyHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "unknown" }));
    const payload = base64url(JSON.stringify({ iss: ISSUER, aud: CLIENT_ID, sub: "auth0|alice", exp: Math.floor(NOW / 1_000) + 100 }));
    const unsigned = `${unknownKeyHeader}.${payload}`;
    const unknownKey = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
    await expect(current.authenticator.verifyIdToken(unknownKey))
      .rejects.toMatchObject({ status: 401, code: "invalid_token" });
    await expect(current.authenticator.verifyIdToken(token("auth0|alice", { aud: [CLIENT_ID, "another-client"], azp: "other-client" })))
      .rejects.toMatchObject({ status: 401, code: "invalid_token" });
  });
});

describe("share-service reservation and publication", () => {
  it("returns a v1 staged policy and recovers the same reservation under concurrent retries", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|alice");
    const input = snapshotInput("attempt-1");
    const [first, second] = await Promise.all([
      reserve(current, identity, input),
      reserve(current, identity, input),
    ]);

    expect(second).toEqual(first);
    expect(first.status).toBe("reserved");
    expect(first.shareId).toMatch(/^[a-f0-9]{32}$/u);
    expect(first.upload).toBeDefined();
    const upload = first.upload!;
    expect(upload.key).toBe(`staging/v1/${first.shareId}.jsonl`);
    expect(upload.maxBytes).toBe(MAX_SNAPSHOT_BYTES);
    expect(upload.fields.key).toBe(upload.key);
    expect(upload.fields["x-share-version"]).toBe("v1");
    await expect(reserve(current, identity, { ...input, title: "different" }))
      .rejects.toMatchObject({ status: 409, code: "attempt_conflict" });
  });

  it("freezes validated bytes, binds copy to the staged object identity, and makes lost-response retries idempotent", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|alice");
    const input = snapshotInput("attempt-2");
    const reservation = await reserve(current, identity, input);
    await current.objectStore.putStaging(reservation.upload!.key, SNAPSHOT);

    const [first, retry] = await Promise.all([
      current.service.finalize(identity, reservation.shareId),
      current.service.finalize(identity, reservation.shareId),
    ]);
    expect(first.shareId).toBe(reservation.shareId);
    expect([first.status, retry.status].sort()).toEqual(["already-created", "created"]);
    expect(first.url).toBe(retry.url);
    expect(await current.repository.listPublished(identity.ownerHash)).toHaveLength(1);
    const counters = await current.repository.counters(reservation.shareId);
    expect(counters).toEqual({ pageRequests: 0, installClicks: 0 });

    // The staging object is intentionally gone after success. A retry still
    // recovers the committed result, proving the result boundary is durable.
    await expect(current.service.finalize(identity, reservation.shareId)).resolves.toMatchObject({
      status: "already-created",
      shareId: reservation.shareId,
    });
  });

  it("does not charge quota for invalid JSON, mismatched bytes, or object-store failure", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|alice");
    const malformed = new TextEncoder().encode("not json\n");
    const malformedInput = snapshotInput("attempt-invalid", "Invalid", {
      byteLength: malformed.byteLength,
      lineCount: 1,
      snapshotSha256: createHash("sha256").update(malformed).digest("hex"),
    });
    const malformedReservation = await reserve(current, identity, malformedInput);
    await current.objectStore.putStaging(malformedReservation.upload!.key, malformed);
    await expect(current.service.finalize(identity, malformedReservation.shareId))
      .rejects.toMatchObject({ status: 422, code: "snapshot_invalid_json" });

    const mismatchInput = snapshotInput("attempt-mismatch");
    const mismatchReservation = await reserve(current, identity, mismatchInput);
    await current.objectStore.putStaging(mismatchReservation.upload!.key, new TextEncoder().encode('{"other":true}\n'));
    await expect(current.service.finalize(identity, mismatchReservation.shareId))
      .rejects.toMatchObject({ status: 422, code: "snapshot_mismatch" });

    const storageInput = snapshotInput("attempt-storage");
    const storageReservation = await reserve(current, identity, storageInput);
    await current.objectStore.putStaging(storageReservation.upload!.key, SNAPSHOT);
    await current.objectStore.failNext("copyIfMatch");
    await expect(current.service.finalize(identity, storageReservation.shareId))
      .rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
    expect(await current.repository.listPublished(identity.ownerHash)).toHaveLength(0);
  });

  it("enforces the successful UTC-day quota atomically across concurrent shares", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|quota");
    const reservations = [];
    for (let index = 0; index < 21; index += 1) {
      const reservation = await reserve(current, identity, snapshotInput(`quota-${index}`, `Title ${index}`));
      await current.objectStore.putStaging(reservation.upload!.key, SNAPSHOT);
      reservations.push(reservation);
    }
    const outcomes = await Promise.allSettled(reservations.map((reservation) => (
      current.service.finalize(identity, reservation.shareId)
    )));
    const successes = outcomes.filter((outcome): outcome is PromiseFulfilledResult<FinalizeResult> => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(successes).toHaveLength(20);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatchObject({ status: 429, code: "daily_quota_exhausted" });
    expect((failures[0]!.reason as ShareServiceError).data.resetAt).toBe(new Date(Date.UTC(2030, 2, 18)).toISOString());
    expect(await current.repository.listPublished(identity.ownerHash)).toHaveLength(20);
  });
});

describe("share-service owner and public read seams", () => {
  it("keeps owner metadata scoped and gives foreign/unknown/deleted pages the same 404", async () => {
    const current = fixture();
    const alice = await identityFor(current.authenticator, "auth0|alice");
    const bob = await identityFor(current.authenticator, "auth0|bob");
    const { reservation } = await publishFixture(current, alice, snapshotInput("attempt-owner"));

    const foreignList = await current.service.list(bob);
    expect(foreignList).toEqual([]);
    await expect(current.service.finalize(bob, reservation.shareId)).rejects.toMatchObject({ status: 404, code: "not_found" });
    const foreignRead = await current.service.handle({
      method: "GET",
      path: `/shares/${reservation.shareId}`,
      headers: { authorization: `Bearer ${token("auth0|bob")}` },
    });
    expect(foreignRead).toEqual(expect.objectContaining({ status: 404, body: { error: "not_found" } }));

    const unknownPage = await current.service.handle({ method: "GET", path: `/t/${"f".repeat(32)}` });
    await current.repository.markDeleted(reservation.shareId);
    const deletedPage = await current.service.handle({ method: "GET", path: `/t/${reservation.shareId}` });
    expect(deletedPage).toEqual(unknownPage);
    const unknownInstall = await current.service.handle({ method: "GET", path: `/t/${"f".repeat(32)}/install` });
    const deletedInstall = await current.service.handle({ method: "GET", path: `/t/${reservation.shareId}/install` });
    expect(deletedInstall).toEqual(unknownInstall);
  });

  it("serves the pinned manifest, counts repeated page/install requests, and does not expose counters", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|viewer");
    const { reservation } = await publishFixture(current, identity, snapshotInput("attempt-view"));

    const first = await current.service.publicPage(reservation.shareId);
    const second = await current.service.handle({ method: "GET", path: `/t/${reservation.shareId}` });
    expect(first.snapshotBytes).toEqual(SNAPSHOT);
    expect(first.assetManifest).toEqual(ASSET_MANIFEST);
    expect(second.status).toBe(200);
    expect(JSON.stringify(second.body)).not.toContain("pageRequestCount");
    await expect(current.service.install(reservation.shareId)).resolves.toEqual({
      shareId: reservation.shareId,
      location: INSTALL_URL,
    });
    const counters = await current.repository.counters(reservation.shareId);
    expect(counters).toEqual({ pageRequests: 2, installClicks: 1 });
    expect(current.pageCache.invalidatedShareIds).toEqual([]);
    await current.service.invalidatePage(reservation.shareId);
    expect(current.pageCache.invalidatedShareIds).toEqual([reservation.shareId]);
  });

  it("returns the owner's source-thread association and chosen metadata without changing the local source", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|metadata");
    const input = snapshotInput("attempt-metadata", "Chosen public title");
    const { reservation } = await publishFixture(current, identity, input);
    const items = await current.service.list(identity);
    expect(items).toEqual([expect.objectContaining({
      shareId: reservation.shareId,
      sourceThreadId: "thread:42",
      title: "Chosen public title",
      projectName: "Public project",
    })]);
  });
});

describe("JSONL validation seam", () => {
  it("checks UTF-8, whole-file size, line bounds, and syntax without graph interpretation", () => {
    expect(validateSnapshotBytes(new TextEncoder().encode('{"recordType":"anything"}\nnull\n'))).toMatchObject({ lineCount: 2 });
    expect(() => validateSnapshotBytes(new TextEncoder().encode("\n"))).toThrowError(SnapshotValidationError);
    expect(() => validateSnapshotBytes(new Uint8Array([0xc3, 0x28]))).toThrowError(SnapshotValidationError);
    expect(() => validateSnapshotBytes(new TextEncoder().encode("not-json"))).toThrowError(SnapshotValidationError);
    expect(() => validateSnapshotBytes(new Uint8Array(MAX_SNAPSHOT_BYTES + 1))).toThrowError(/snapshot_too_large/);
  });
});

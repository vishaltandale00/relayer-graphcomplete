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
  MAX_ACTIVE_RESERVATIONS_PER_OWNER,
  MAX_SNAPSHOT_BYTES,
  ObjectStoreError,
  SnapshotValidationError,
  validateSnapshotBytes,
  type FinalizeResult,
  type ReserveResult,
  type ShareAttemptInput,
  type ShareObjectStore,
  type ShareRepository,
  type ShareServiceError,
} from "../src/index.js";

const NOW = 1_900_000_000_000;
const ISSUER = "https://auth.example.test/";
const CLIENT_ID = "desktop-client";
const INSTALL_URL = "https://app.relayerlabs.ai/desktop/login";
const ASSET_MANIFEST = {
  version: 1 as const,
  assets: {
    logo: "assets/commit-abc/relayer-logo.svg",
    ogImage: "assets/commit-abc/relayer-share-og.svg",
    viewerScript: "assets/commit-abc/viewer.js",
    viewerStyles: "assets/commit-abc/viewer.css",
    workspaceStyles: "assets/commit-abc/workspace.css",
    lucideScript: "assets/commit-abc/lucide.min.js",
    markedScript: "assets/commit-abc/marked.umd.js",
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

  it("atomically bounds active reservations per owner while preserving exact retries", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|reservation-bound");
    let first: ReserveResult | undefined;
    const outcomes = await Promise.allSettled(Array.from(
      { length: MAX_ACTIVE_RESERVATIONS_PER_OWNER + 8 },
      async (_, index) => {
        const reserved = await reserve(current, identity, snapshotInput(`bounded-${index}`));
        if (index === 0) first = reserved;
        return reserved;
      },
    ));
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(successes).toHaveLength(MAX_ACTIVE_RESERVATIONS_PER_OWNER);
    expect(failures).toHaveLength(8);
    expect(failures.every((failure) => (
      failure.reason instanceof Error
        && (failure.reason as ShareServiceError).code === "reservation_limit_exhausted"
    ))).toBe(true);
    await expect(reserve(current, identity, snapshotInput("bounded-0"))).resolves.toEqual(first);
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

  it("reconciles a committed publication whose repository response is lost", async () => {
    const current = fixture();
    const repository = new Proxy(current.repository, {
      get(target, property, receiver) {
        if (property === "publishIfEligible") {
          return async (input: Parameters<typeof target.publishIfEligible>[0]) => {
            await target.publishIfEligible(input);
            throw new Error("lost DynamoDB response");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = createShareService({
      authenticator: current.authenticator,
      repository,
      objectStore: current.objectStore,
      publicOrigin: "https://share.example.test",
      installRedirectUrl: INSTALL_URL,
      assetManifest: ASSET_MANIFEST,
      now: () => NOW,
      randomShareId: () => "a".repeat(32),
    });
    const identity = await identityFor(current.authenticator, "auth0|lost-database-response");
    const reservation = await service.reserve(identity, snapshotInput("attempt-lost-database-response"));
    await current.objectStore.putStaging(reservation.upload!.key, SNAPSHOT);

    await expect(service.finalize(identity, reservation.shareId)).resolves.toMatchObject({
      status: "already-created",
      shareId: reservation.shareId,
    });
    await expect(service.publicPage(reservation.shareId)).resolves.toMatchObject({
      shareId: reservation.shareId,
      snapshotBytes: SNAPSHOT,
    });
  });

  it("reconciles a retained immutable object after a pre-commit repository failure", async () => {
    const current = fixture();
    let failBeforeCommit = true;
    const repository = new Proxy(current.repository, {
      get(target, property, receiver) {
        if (property === "publishIfEligible") {
          return async (input: Parameters<ShareRepository["publishIfEligible"]>[0]) => {
            if (failBeforeCommit) {
              failBeforeCommit = false;
              throw new Error("DynamoDB unavailable before commit");
            }
            return target.publishIfEligible(input);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let copied = false;
    const objectStore = new Proxy(current.objectStore, {
      get(target, property, receiver) {
        if (property === "copyIfMatch") {
          return async (input: Parameters<ShareObjectStore["copyIfMatch"]>[0]) => {
            if (copied) throw new ObjectStoreError("destination_exists");
            copied = true;
            return target.copyIfMatch(input);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = createShareService({
      authenticator: current.authenticator,
      repository,
      objectStore,
      publicOrigin: "https://share.example.test",
      installRedirectUrl: INSTALL_URL,
      assetManifest: ASSET_MANIFEST,
      now: () => NOW,
      randomShareId: () => "b".repeat(32),
    });
    const identity = await identityFor(current.authenticator, "auth0|precommit-recovery");
    const reservation = await service.reserve(identity, snapshotInput("attempt-precommit-recovery"));
    await current.objectStore.putStaging(reservation.upload!.key, SNAPSHOT);

    await expect(service.finalize(identity, reservation.shareId))
      .rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
    await expect(service.finalize(identity, reservation.shareId)).resolves.toMatchObject({
      status: "created",
      shareId: reservation.shareId,
    });
    expect(await current.repository.listPublished(identity.ownerHash)).toHaveLength(1);
  });

  it("rejects finalization after the reservation upload policy expires", async () => {
    let currentTime = NOW;
    const current = fixture();
    const service = createShareService({
      authenticator: current.authenticator,
      repository: current.repository,
      objectStore: current.objectStore,
      publicOrigin: "https://share.example.test",
      installRedirectUrl: INSTALL_URL,
      assetManifest: ASSET_MANIFEST,
      now: () => currentTime,
      stagingTtlMs: 1_000,
      randomShareId: () => "c".repeat(32),
    });
    const identity = await identityFor(current.authenticator, "auth0|expired-reservation");
    const reservation = await service.reserve(identity, snapshotInput("attempt-expired-reservation"));
    currentTime += 1_001;
    await expect(service.finalize(identity, reservation.shareId))
      .rejects.toMatchObject({ status: 410, code: "reservation_expired" });
  });

  it("does not charge quota for invalid JSON, mismatched bytes, or object-store failure", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|alice");
    const malformed = new TextEncoder().encode('{"recordType":"header","exportVersion":1}\nnot json\n');
    const malformedInput = snapshotInput("attempt-invalid", "Invalid", {
      byteLength: malformed.byteLength,
      lineCount: 2,
      snapshotSha256: createHash("sha256").update(malformed).digest("hex"),
    });
    const malformedReservation = await reserve(current, identity, malformedInput);
    await current.objectStore.putStaging(malformedReservation.upload!.key, malformed);
    await expect(current.service.finalize(identity, malformedReservation.shareId))
      .rejects.toMatchObject({ status: 422, code: "snapshot_invalid_json" });

    const mismatchInput = snapshotInput("attempt-mismatch");
    const mismatchReservation = await reserve(current, identity, mismatchInput);
    await current.objectStore.putStaging(
      mismatchReservation.upload!.key,
      new TextEncoder().encode('{"recordType":"header","exportVersion":1}\n{"recordType":"turn","id":"different"}\n'),
    );
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
    await expect(current.service.quota(identity)).resolves.toEqual({
      used: 20,
      limit: 20,
      resetAt: new Date(Date.UTC(2030, 2, 18)).toISOString(),
    });
    await expect(current.service.handle({
      method: "GET",
      path: "/shares/quota",
      headers: { authorization: `Bearer ${token("auth0|quota")}` },
    })).resolves.toMatchObject({
      status: 200,
      body: { used: 20, limit: 20 },
    });
  });

  it("never lets a quota loser delete an immutable object published by another service instance", async () => {
    const current = fixture();
    const identity = await identityFor(current.authenticator, "auth0|cross-instance-quota");
    for (let index = 0; index < 20; index += 1) {
      await publishFixture(current, identity, snapshotInput(`filled-${index}`, `Filled ${index}`));
    }
    const target = await reserve(current, identity, snapshotInput("cross-instance-target"));
    await current.objectStore.putStaging(target.upload!.key, SNAPSHOT);

    let currentTime = NOW;
    let quotaDecisionReached!: () => void;
    const quotaDecision = new Promise<void>((resolve) => { quotaDecisionReached = resolve; });
    let releaseQuotaLoser!: () => void;
    const quotaLoserReleased = new Promise<void>((resolve) => { releaseQuotaLoser = resolve; });
    const pausedRepository = new Proxy(current.repository, {
      get(targetRepository, property, receiver) {
        if (property === "publishIfEligible") {
          return async (input: Parameters<ShareRepository["publishIfEligible"]>[0]) => {
            const decision = await targetRepository.publishIfEligible(input);
            if (decision.kind === "quota-exhausted") {
              quotaDecisionReached();
              await quotaLoserReleased;
            }
            return decision;
          };
        }
        const value = Reflect.get(targetRepository, property, receiver);
        return typeof value === "function" ? value.bind(targetRepository) : value;
      },
    });
    const serviceOptions = {
      authenticator: current.authenticator,
      objectStore: current.objectStore,
      publicOrigin: "https://share.example.test",
      installRedirectUrl: INSTALL_URL,
      assetManifest: ASSET_MANIFEST,
      now: () => currentTime,
    };
    const quotaLoser = createShareService({ ...serviceOptions, repository: pausedRepository });
    const nextDayWinner = createShareService({ ...serviceOptions, repository: current.repository });

    const losingFinalize = quotaLoser.finalize(identity, target.shareId);
    await quotaDecision;
    const currentDate = new Date(NOW);
    currentTime = Date.UTC(
      currentDate.getUTCFullYear(),
      currentDate.getUTCMonth(),
      currentDate.getUTCDate() + 1,
    ) + 1;
    await expect(nextDayWinner.finalize(identity, target.shareId)).resolves.toMatchObject({ status: "created" });
    releaseQuotaLoser();
    await expect(losingFinalize).rejects.toMatchObject({ status: 429, code: "daily_quota_exhausted" });
    await expect(nextDayWinner.publicPage(target.shareId)).resolves.toMatchObject({
      shareId: target.shareId,
      snapshotBytes: SNAPSHOT,
    });
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
    expect(validateSnapshotBytes(SNAPSHOT)).toMatchObject({ lineCount: 2 });
    expect(() => validateSnapshotBytes(new TextEncoder().encode("\n"))).toThrowError(SnapshotValidationError);
    expect(() => validateSnapshotBytes(new Uint8Array([0xc3, 0x28]))).toThrowError(SnapshotValidationError);
    expect(() => validateSnapshotBytes(new TextEncoder().encode("not-json"))).toThrowError(SnapshotValidationError);
    expect(() => validateSnapshotBytes(new TextEncoder().encode('{"recordType":"header","exportVersion":999}\n{"recordType":"turn"}\n')))
      .toThrowError(/snapshot_unsupported_version/);
    expect(() => validateSnapshotBytes(new TextEncoder().encode('{"recordType":"header","exportVersion":1}\nnull\n')))
      .toThrowError(/snapshot_invalid_record/);
    expect(() => validateSnapshotBytes(new Uint8Array(MAX_SNAPSHOT_BYTES + 1))).toThrowError(/snapshot_too_large/);
  });
});

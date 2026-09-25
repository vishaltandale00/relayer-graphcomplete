import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";

export const SHARE_VERSION = "v1" as const;
export const OWNER_HASH_DOMAIN_SEPARATOR = "graphcomplete-share-owner-v1\0";
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_JSONL_LINES = 10_001;
export const MAX_SHARES_PER_UTC_DAY = 20;
export const DEFAULT_STAGING_TTL_MS = 24 * 60 * 60 * 1_000;

type JsonObject = Record<string, unknown>;
export type JwksKey = Readonly<Record<string, unknown>>;

export interface JwksProvider {
  readonly getKeys: () => Promise<readonly JwksKey[]>;
}

export interface ShareAuthenticator {
  readonly verifyBearer: (authorization: string | undefined) => Promise<VerifiedShareIdentity>;
}

export interface VerifiedShareIdentity {
  readonly ownerHash: string;
}

export interface Auth0VerifierOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly jwks: JwksProvider;
  readonly now?: () => number;
}

export interface UploadPolicy {
  readonly method: "POST";
  readonly url: string;
  readonly key: string;
  readonly expiresAt: string;
  readonly maxBytes: number;
  readonly fields: Readonly<Record<string, string>>;
}

export interface StoredShareObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly versionId: string;
}

export interface ShareObjectStore {
  readonly createUploadPolicy: (input: {
    readonly key: string;
    readonly maxBytes: number;
    readonly expiresAt: string;
  }) => Promise<UploadPolicy>;
  readonly read: (key: string) => Promise<StoredShareObject | null>;
  /** Copies only the exact source identity and never replaces an existing final key. */
  readonly copyIfMatch: (input: {
    readonly sourceKey: string;
    readonly destinationKey: string;
    readonly sourceEtag: string;
    readonly sourceVersionId: string;
  }) => Promise<StoredShareObject>;
  readonly delete: (key: string) => Promise<void>;
}

export type ShareStatus = "reserved" | "published" | "deleted";

export interface PinnedAssetManifest {
  readonly version: 1;
  readonly assets: Readonly<Record<string, string>>;
}

export interface ShareRecord {
  readonly shareId: string;
  readonly version: typeof SHARE_VERSION;
  readonly ownerHash: string;
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly sourceThreadId: string;
  readonly title: string;
  readonly projectName?: string;
  readonly createdAt: string;
  readonly status: ShareStatus;
  readonly stagingKey: string;
  readonly finalKey: string;
  readonly uploadPolicy: UploadPolicy;
  readonly byteLength: number;
  readonly lineCount: number;
  readonly snapshotSha256: string;
  readonly assetManifest: PinnedAssetManifest;
  readonly publishedAt?: string;
  readonly publishedDay?: string;
  readonly quotaResetAt?: string;
  readonly snapshotEtag?: string;
  readonly snapshotVersionId?: string;
  readonly pageRequestCount: number;
  readonly installClickCount: number;
}

export interface ShareRepository {
  /** Strongly consistent lookup by the server-owned share ID. */
  readonly findShare: (shareId: string) => Promise<ShareRecord | null>;
  /** Strongly consistent owner/attempt lookup used for idempotent retries. */
  readonly findAttempt: (ownerHash: string, attemptId: string) => Promise<ShareRecord | null>;
  /** Must atomically claim both shareId and (ownerHash, attemptId). */
  readonly putIfAbsent: (record: ShareRecord) => Promise<boolean>;
  /** Must atomically transition a reservation and charge the UTC-day quota. */
  readonly publishIfEligible: (input: {
    readonly ownerHash: string;
    readonly shareId: string;
    readonly fingerprint: string;
    readonly snapshotEtag: string;
    readonly snapshotVersionId: string;
    readonly byteLength: number;
    readonly lineCount: number;
    readonly publishedAt: string;
    readonly publishedDay: string;
    readonly quotaResetAt: string;
  }) => Promise<PublishDecision>;
  /** Counter-only updates must never create or resurrect a share row. */
  readonly incrementPageRequest: (shareId: string) => Promise<void>;
  readonly incrementInstallClick: (shareId: string) => Promise<void>;
  readonly listPublished: (ownerHash: string) => Promise<readonly ShareRecord[]>;
}

export type PublishDecision =
  | {
      readonly kind: "published";
      readonly record: ShareRecord;
    }
  | {
      readonly kind: "already-published";
      readonly record: ShareRecord;
    }
  | {
      readonly kind: "quota-exhausted";
      readonly resetAt: string;
      readonly used: number;
      readonly limit: number;
    }
  | {
      readonly kind: "not-found";
    };

export interface ShareAttemptInput {
  readonly attemptId: string;
  readonly sourceThreadId: string;
  readonly title: string;
  readonly projectName?: string;
  readonly byteLength: number;
  readonly lineCount: number;
  readonly snapshotSha256: string;
}

export interface ReserveResult {
  readonly status: "reserved" | "published";
  readonly shareId: string;
  readonly attemptId: string;
  readonly url: string;
  readonly maxBytes: number;
  readonly expiresAt: string;
  readonly upload?: UploadPolicy;
}

export interface FinalizeResult {
  readonly status: "created" | "already-created";
  readonly shareId: string;
  readonly url: string;
  readonly title: string;
  readonly projectName?: string;
  readonly createdAt: string;
  readonly byteLength: number;
  readonly lineCount: number;
  readonly quotaResetAt: string;
}

export interface ShareListItem {
  readonly shareId: string;
  readonly url: string;
  readonly title: string;
  readonly projectName?: string;
  readonly sourceThreadId: string;
  readonly createdAt: string;
}

export interface PublicPageResult {
  readonly shareId: string;
  readonly title: string;
  readonly projectName?: string;
  readonly createdAt: string;
  readonly snapshotBytes: Uint8Array;
  readonly assetManifest: PinnedAssetManifest;
}

export interface InstallResult {
  readonly shareId: string;
  readonly location: string;
}

export interface SharePageCache {
  readonly invalidate: (shareId: string) => Promise<void>;
}

export interface ShareServiceOptions {
  readonly authenticator: ShareAuthenticator;
  readonly repository: ShareRepository;
  readonly objectStore: ShareObjectStore;
  readonly publicOrigin: string;
  readonly installRedirectUrl: string;
  readonly assetManifest: PinnedAssetManifest;
  readonly pageCache?: SharePageCache;
  readonly now?: () => number;
  readonly randomShareId?: () => string;
  readonly stagingTtlMs?: number;
  /** Deployment composition injects the pinned production viewer renderer. */
  readonly renderPublicPage?: (page: PublicPageResult) => string;
}

export interface ShareHttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface ShareHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface ShareService {
  readonly reserve: (identity: VerifiedShareIdentity, input: ShareAttemptInput) => Promise<ReserveResult>;
  readonly finalize: (identity: VerifiedShareIdentity, shareId: string) => Promise<FinalizeResult>;
  readonly list: (identity: VerifiedShareIdentity) => Promise<readonly ShareListItem[]>;
  readonly publicPage: (shareId: string) => Promise<PublicPageResult>;
  readonly install: (shareId: string) => Promise<InstallResult>;
  /** Used by the future owner-delete handler; it does not mutate share state. */
  readonly invalidatePage: (shareId: string) => Promise<void>;
  readonly handle: (request: ShareHttpRequest) => Promise<ShareHttpResponse>;
}

export class ShareServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly data: Readonly<Record<string, unknown>>;

  constructor(status: number, code: string, data: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = "ShareServiceError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export class SnapshotValidationError extends ShareServiceError {
  constructor(code: string) {
    super(code === "snapshot_too_large" ? 413 : 422, code);
    this.name = "SnapshotValidationError";
  }
}

export class ObjectStoreError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ObjectStoreError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64UrlJson(value: string, label: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new ShareServiceError(401, "invalid_token");
  }
}

function normalizeAudience(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as string[];
  }
  return [];
}

export function deriveOwnerHash(subject: string): string {
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 2_048) {
    throw new ShareServiceError(401, "invalid_token");
  }
  return createHash("sha256")
    .update(OWNER_HASH_DOMAIN_SEPARATOR, "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

export function createAuth0Verifier(options: Auth0VerifierOptions): ShareAuthenticator & {
  readonly verifyIdToken: (token: string) => Promise<VerifiedShareIdentity>;
} {
  if (typeof options.issuer !== "string" || !options.issuer) throw new TypeError("Auth0 issuer is required.");
  if (typeof options.clientId !== "string" || !options.clientId) throw new TypeError("Auth0 client ID is required.");
  if (typeof options.jwks?.getKeys !== "function") throw new TypeError("A JWKS provider is required.");
  let issuer: string;
  try {
    issuer = new URL(options.issuer).href;
  } catch {
    throw new TypeError("Auth0 issuer must be an URL.");
  }
  if (!issuer.endsWith("/")) throw new TypeError("Auth0 issuer must end with a slash.");
  const now = options.now ?? Date.now;
  let keysPromise: Promise<readonly JwksKey[]> | undefined;

  async function keys(): Promise<readonly JwksKey[]> {
    keysPromise ??= options.jwks.getKeys().catch((error: unknown) => {
      keysPromise = undefined;
      throw error;
    });
    return keysPromise;
  }

  async function verifyIdToken(token: string): Promise<VerifiedShareIdentity> {
    if (typeof token !== "string") throw new ShareServiceError(401, "invalid_token");
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new ShareServiceError(401, "invalid_token");
    }
    const header = decodeBase64UrlJson(parts[0]!, "header");
    const claims = decodeBase64UrlJson(parts[1]!, "claims");
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) {
      throw new ShareServiceError(401, "invalid_token");
    }
    const key = (await keys()).find((candidate) => (
      candidate.kid === header.kid && candidate.kty === "RSA" &&
      (candidate.alg === undefined || candidate.alg === "RS256")
    ));
    if (!key) throw new ShareServiceError(401, "invalid_token");
    let validSignature = false;
    try {
      validSignature = verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: key as any, format: "jwk" }),
        Buffer.from(parts[2]!, "base64url"),
      );
    } catch {
      validSignature = false;
    }
    const audiences = normalizeAudience(claims.aud);
    const nowSeconds = Math.floor(now() / 1_000);
    const validClaims = (
      claims.iss === issuer
      && audiences.includes(options.clientId)
      && (claims.azp === undefined || claims.azp === options.clientId)
      && (audiences.length <= 1 || claims.azp === options.clientId)
      && typeof claims.exp === "number"
      && Number.isInteger(claims.exp)
      && claims.exp > nowSeconds
      && typeof claims.sub === "string"
      && claims.sub.length > 0
    );
    if (!validSignature || !validClaims || typeof claims.sub !== "string") {
      throw new ShareServiceError(401, "invalid_token");
    }
    return Object.freeze({ ownerHash: deriveOwnerHash(claims.sub) });
  }

  return Object.freeze({
    verifyIdToken,
    verifyBearer: async (authorization: string | undefined) => {
      if (typeof authorization !== "string") throw new ShareServiceError(401, "missing_authorization");
      const parts = authorization.trim().split(/\s+/u);
      if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer" || parts[1]!.length === 0) {
        throw new ShareServiceError(401, "invalid_authorization");
      }
      return verifyIdToken(parts[1]!);
    },
  });
}

export function createStaticJwksProvider(keys: readonly JwksKey[]): JwksProvider {
  const snapshot = keys.map((key) => Object.freeze({ ...key }));
  return Object.freeze({ getKeys: async () => snapshot });
}

function validateOwnerHash(ownerHash: string): void {
  if (!/^[a-f0-9]{64}$/u.test(ownerHash)) throw new ShareServiceError(401, "invalid_identity");
}

function validateShareId(shareId: string): void {
  if (!/^[a-f0-9]{32}$/u.test(shareId)) throw new ShareServiceError(404, "not_found");
}

function validateAttemptId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw new ShareServiceError(400, "invalid_attempt_id");
  }
  return value;
}

function validateTitle(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Array.from(value).length > 120) {
    throw new ShareServiceError(400, "invalid_share_title");
  }
  return value;
}

function validateOptionalMetadata(value: unknown, code: string, maxCharacters: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Array.from(value).length > maxCharacters) {
    throw new ShareServiceError(400, code);
  }
  return value;
}

function validateAttemptInput(input: ShareAttemptInput): ShareAttemptInput {
  if (!isRecord(input)) throw new ShareServiceError(400, "invalid_request");
  const attemptId = validateAttemptId(input.attemptId);
  const sourceThreadId = validateOptionalMetadata(input.sourceThreadId, "invalid_source_thread", 256);
  if (!sourceThreadId || sourceThreadId.trim().length === 0) throw new ShareServiceError(400, "invalid_source_thread");
  const title = validateTitle(input.title);
  const projectName = validateOptionalMetadata(input.projectName, "invalid_project_name", 256);
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || input.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new ShareServiceError(413, "snapshot_too_large");
  }
  if (!Number.isSafeInteger(input.lineCount) || input.lineCount <= 0 || input.lineCount > MAX_JSONL_LINES) {
    throw new ShareServiceError(400, "invalid_snapshot_line_count");
  }
  if (typeof input.snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.snapshotSha256)) {
    throw new ShareServiceError(400, "invalid_snapshot_digest");
  }
  const result: ShareAttemptInput = {
    attemptId,
    sourceThreadId,
    title,
    byteLength: input.byteLength,
    lineCount: input.lineCount,
    snapshotSha256: input.snapshotSha256,
  };
  if (projectName !== undefined) return { ...result, projectName };
  return result;
}

function canonicalFingerprint(input: ShareAttemptInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: SHARE_VERSION,
      sourceThreadId: input.sourceThreadId,
      title: input.title,
      ...(input.projectName === undefined ? {} : { projectName: input.projectName }),
      byteLength: input.byteLength,
      lineCount: input.lineCount,
      snapshotSha256: input.snapshotSha256,
    }), "utf8")
    .digest("hex");
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcMidnight(now: number): string {
  const date = new Date(now);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return new Date(next).toISOString();
}

function publicUrl(origin: string, shareId: string): string {
  return `${origin}/t/${shareId}`;
}

function cloneManifest(manifest: PinnedAssetManifest): PinnedAssetManifest {
  return Object.freeze({
    version: 1 as const,
    assets: Object.freeze({ ...manifest.assets }),
  });
}

function validateManifest(manifest: PinnedAssetManifest): PinnedAssetManifest {
  if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.assets)) {
    throw new TypeError("A version-1 viewer asset manifest is required.");
  }
  const assets: Record<string, string> = {};
  for (const [name, path] of Object.entries(manifest.assets)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(name) || typeof path !== "string" ||
        !path.startsWith("assets/") || path.includes("..") || path.includes("?") || path.includes("#")) {
      throw new TypeError("Viewer asset manifest contains an invalid pinned path.");
    }
    assets[name] = path;
  }
  if (Object.keys(assets).length === 0) throw new TypeError("Viewer asset manifest cannot be empty.");
  return Object.freeze({ version: 1, assets: Object.freeze(assets) });
}

function clonePolicy(policy: UploadPolicy): UploadPolicy {
  return Object.freeze({ ...policy, fields: Object.freeze({ ...policy.fields }) });
}

function cloneRecord(record: ShareRecord): ShareRecord {
  const copy: ShareRecord = {
    ...record,
    uploadPolicy: clonePolicy(record.uploadPolicy),
    assetManifest: cloneManifest(record.assetManifest),
  };
  return Object.freeze(copy);
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = current;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tails.get(key) ?? Promise.resolve();
    this.tails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

export class InMemoryShareRepository implements ShareRepository {
  private readonly records = new Map<string, ShareRecord>();
  private readonly attempts = new Map<string, string>();
  private readonly quotaUse = new Map<string, number>();
  private readonly mutex = new AsyncMutex();

  async findShare(shareId: string): Promise<ShareRecord | null> {
    return this.mutex.run(() => {
      const record = this.records.get(shareId);
      return record ? cloneRecord(record) : null;
    });
  }

  async findAttempt(ownerHash: string, attemptId: string): Promise<ShareRecord | null> {
    return this.mutex.run(() => {
      const shareId = this.attempts.get(`${ownerHash}:${attemptId}`);
      const record = shareId === undefined ? undefined : this.records.get(shareId);
      return record ? cloneRecord(record) : null;
    });
  }

  async putIfAbsent(record: ShareRecord): Promise<boolean> {
    return this.mutex.run(() => {
      const attemptKey = `${record.ownerHash}:${record.attemptId}`;
      if (this.records.has(record.shareId) || this.attempts.has(attemptKey)) return false;
      this.records.set(record.shareId, cloneRecord(record));
      this.attempts.set(attemptKey, record.shareId);
      return true;
    });
  }

  async publishIfEligible(input: {
    readonly ownerHash: string;
    readonly shareId: string;
    readonly fingerprint: string;
    readonly snapshotEtag: string;
    readonly snapshotVersionId: string;
    readonly byteLength: number;
    readonly lineCount: number;
    readonly publishedAt: string;
    readonly publishedDay: string;
    readonly quotaResetAt: string;
  }): Promise<PublishDecision> {
    return this.mutex.run(() => {
      const current = this.records.get(input.shareId);
      if (!current || current.ownerHash !== input.ownerHash || current.status === "deleted") {
        return { kind: "not-found" };
      }
      if (current.fingerprint !== input.fingerprint) return { kind: "not-found" };
      if (current.status === "published") return { kind: "already-published", record: cloneRecord(current) };
      const quotaKey = `${input.ownerHash}:${input.publishedDay}`;
      const used = this.quotaUse.get(quotaKey) ?? 0;
      if (used >= MAX_SHARES_PER_UTC_DAY) {
        return {
          kind: "quota-exhausted",
          resetAt: input.quotaResetAt,
          used,
          limit: MAX_SHARES_PER_UTC_DAY,
        };
      }
      const published: ShareRecord = {
        ...current,
        status: "published",
        publishedAt: input.publishedAt,
        publishedDay: input.publishedDay,
        quotaResetAt: input.quotaResetAt,
        snapshotEtag: input.snapshotEtag,
        snapshotVersionId: input.snapshotVersionId,
        byteLength: input.byteLength,
        lineCount: input.lineCount,
      };
      this.records.set(input.shareId, cloneRecord(published));
      this.quotaUse.set(quotaKey, used + 1);
      return { kind: "published", record: cloneRecord(published) };
    });
  }

  async incrementPageRequest(shareId: string): Promise<void> {
    await this.mutex.run(() => {
      const current = this.records.get(shareId);
      if (!current || current.status !== "published") return;
      this.records.set(shareId, cloneRecord({ ...current, pageRequestCount: current.pageRequestCount + 1 }));
    });
  }

  async incrementInstallClick(shareId: string): Promise<void> {
    await this.mutex.run(() => {
      const current = this.records.get(shareId);
      if (!current || current.status !== "published") return;
      this.records.set(shareId, cloneRecord({ ...current, installClickCount: current.installClickCount + 1 }));
    });
  }

  async listPublished(ownerHash: string): Promise<readonly ShareRecord[]> {
    return this.mutex.run(() => [...this.records.values()]
      .filter((record) => record.ownerHash === ownerHash && record.status === "published")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneRecord));
  }

  async markDeleted(shareId: string): Promise<void> {
    await this.mutex.run(() => {
      const current = this.records.get(shareId);
      if (current) this.records.set(shareId, cloneRecord({ ...current, status: "deleted" }));
    });
  }

  async counters(shareId: string): Promise<{ readonly pageRequests: number; readonly installClicks: number }> {
    return this.mutex.run(() => {
      const current = this.records.get(shareId);
      return {
        pageRequests: current?.pageRequestCount ?? 0,
        installClicks: current?.installClickCount ?? 0,
      };
    });
  }
}

function etagFor(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class InMemoryShareObjectStore implements ShareObjectStore {
  private readonly objects = new Map<string, StoredShareObject>();
  private readonly policies = new Map<string, UploadPolicy>();
  private nextVersion = 1;
  private readonly now: () => number;
  private readonly failures = new Map<string, Error>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async createUploadPolicy(input: {
    readonly key: string;
    readonly maxBytes: number;
    readonly expiresAt: string;
  }): Promise<UploadPolicy> {
    this.consumeFailure("createUploadPolicy");
    const policy: UploadPolicy = Object.freeze({
      method: "POST",
      url: "https://objects.invalid/upload",
      key: input.key,
      expiresAt: input.expiresAt,
      maxBytes: input.maxBytes,
      fields: Object.freeze({ key: input.key, "x-share-version": SHARE_VERSION }),
    });
    this.policies.set(input.key, policy);
    return policy;
  }

  async read(key: string): Promise<StoredShareObject | null> {
    this.consumeFailure("read");
    const object = this.objects.get(key);
    if (!object) return null;
    return Object.freeze({ ...object, bytes: new Uint8Array(object.bytes) });
  }

  async copyIfMatch(input: {
    readonly sourceKey: string;
    readonly destinationKey: string;
    readonly sourceEtag: string;
    readonly sourceVersionId: string;
  }): Promise<StoredShareObject> {
    this.consumeFailure("copyIfMatch");
    const source = this.objects.get(input.sourceKey);
    if (!source) throw new ObjectStoreError("not_found");
    if (source.etag !== input.sourceEtag || source.versionId !== input.sourceVersionId) {
      throw new ObjectStoreError("precondition_failed");
    }
    const existing = this.objects.get(input.destinationKey);
    if (existing) {
      if (existing.etag === source.etag) {
        return Object.freeze({ ...existing, bytes: new Uint8Array(existing.bytes) });
      }
      throw new ObjectStoreError("destination_exists");
    }
    const copy: StoredShareObject = Object.freeze({
      key: input.destinationKey,
      bytes: new Uint8Array(source.bytes),
      etag: source.etag,
      versionId: `v${this.nextVersion++}`,
    });
    this.objects.set(input.destinationKey, copy);
    return Object.freeze({ ...copy, bytes: new Uint8Array(copy.bytes) });
  }

  async delete(key: string): Promise<void> {
    this.consumeFailure("delete");
    this.objects.delete(key);
  }

  async putStaging(key: string, bytes: Uint8Array): Promise<void> {
    const policy = this.policies.get(key);
    if (!policy) throw new ObjectStoreError("upload_not_authorized");
    if (Date.parse(policy.expiresAt) <= this.now()) throw new ObjectStoreError("upload_expired");
    if (bytes.byteLength > policy.maxBytes) throw new ObjectStoreError("upload_too_large");
    this.put(key, bytes);
  }

  /** Test-only adapter hook for malformed/oversized object fixtures. */
  async putObjectForTesting(key: string, bytes: Uint8Array): Promise<void> {
    this.put(key, bytes);
  }

  async failNext(operation: string, error = new ObjectStoreError("unavailable")): Promise<void> {
    this.failures.set(operation, error);
  }

  private put(key: string, bytes: Uint8Array): void {
    this.objects.set(key, Object.freeze({
      key,
      bytes: new Uint8Array(bytes),
      etag: etagFor(bytes),
      versionId: `v${this.nextVersion++}`,
    }));
  }

  private consumeFailure(operation: string): void {
    const error = this.failures.get(operation);
    if (!error) return;
    this.failures.delete(operation);
    throw error;
  }
}

export class InMemorySharePageCache implements SharePageCache {
  readonly invalidatedShareIds: string[] = [];

  async invalidate(shareId: string): Promise<void> {
    this.invalidatedShareIds.push(shareId);
  }
}

export interface SnapshotValidation {
  readonly byteLength: number;
  readonly lineCount: number;
  readonly sha256: string;
}

export function validateSnapshotBytes(bytes: Uint8Array, limits: {
  readonly maxBytes?: number;
  readonly maxLineBytes?: number;
  readonly maxLines?: number;
} = {}): SnapshotValidation {
  const maxBytes = limits.maxBytes ?? MAX_SNAPSHOT_BYTES;
  const maxLineBytes = limits.maxLineBytes ?? MAX_JSONL_LINE_BYTES;
  const maxLines = limits.maxLines ?? MAX_JSONL_LINES;
  const source = new Uint8Array(bytes);
  if (source.byteLength === 0) throw new SnapshotValidationError("snapshot_empty");
  if (source.byteLength > maxBytes) throw new SnapshotValidationError("snapshot_too_large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new SnapshotValidationError("snapshot_invalid_utf8");
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > maxLines) throw new SnapshotValidationError("snapshot_line_count");
  const encoder = new TextEncoder();
  for (const line of lines) {
    if (line.length === 0) throw new SnapshotValidationError("snapshot_empty_line");
    if (encoder.encode(line).byteLength > maxLineBytes) throw new SnapshotValidationError("snapshot_line_too_large");
    try {
      JSON.parse(line);
    } catch {
      throw new SnapshotValidationError("snapshot_invalid_json");
    }
  }
  return Object.freeze({
    byteLength: source.byteLength,
    lineCount: lines.length,
    sha256: etagFor(source),
  });
}

function toReserveResult(record: ShareRecord, origin: string): ReserveResult {
  const base = {
    status: record.status === "published" ? "published" as const : "reserved" as const,
    shareId: record.shareId,
    attemptId: record.attemptId,
    url: publicUrl(origin, record.shareId),
    maxBytes: MAX_SNAPSHOT_BYTES,
    expiresAt: record.uploadPolicy.expiresAt,
  };
  if (record.status === "reserved") return Object.freeze({ ...base, upload: clonePolicy(record.uploadPolicy) });
  return Object.freeze(base);
}

function toFinalizeResult(record: ShareRecord, origin: string, status: "created" | "already-created"): FinalizeResult {
  const base = {
    status,
    shareId: record.shareId,
    url: publicUrl(origin, record.shareId),
    title: record.title,
    createdAt: record.createdAt,
    byteLength: record.byteLength,
    lineCount: record.lineCount,
    quotaResetAt: record.quotaResetAt ?? record.createdAt,
  };
  if (record.projectName === undefined) return Object.freeze(base);
  return Object.freeze({ ...base, projectName: record.projectName });
}

function toListItem(record: ShareRecord, origin: string): ShareListItem {
  const base = {
    shareId: record.shareId,
    url: publicUrl(origin, record.shareId),
    title: record.title,
    sourceThreadId: record.sourceThreadId,
    createdAt: record.createdAt,
  };
  if (record.projectName === undefined) return Object.freeze(base);
  return Object.freeze({ ...base, projectName: record.projectName });
}

function parseBody(value: unknown): JsonObject {
  if (isRecord(value)) return value;
  if (value instanceof Uint8Array || typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value));
      if (isRecord(parsed)) return parsed;
    } catch {
      // Fall through to the closed request error below.
    }
  }
  throw new ShareServiceError(400, "invalid_request");
}

function headerValue(headers: Readonly<Record<string, string | undefined>> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const expected = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === expected);
  return entry?.[1];
}

function jsonResponse(status: number, body: unknown): ShareHttpResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }),
    body,
  });
}

function notFound(): never {
  throw new ShareServiceError(404, "not_found");
}

export function createShareService(options: ShareServiceOptions): ShareService {
  if (typeof options.authenticator?.verifyBearer !== "function") throw new TypeError("Share authentication is required.");
  if (!options.repository || typeof options.repository.findShare !== "function") throw new TypeError("Share repository is required.");
  if (!options.objectStore || typeof options.objectStore.read !== "function") throw new TypeError("Share object storage is required.");
  const originUrl = new URL(options.publicOrigin);
  if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") throw new TypeError("Share public origin must be HTTP(S).");
  const origin = originUrl.href.replace(/\/$/u, "");
  const installUrl = new URL(options.installRedirectUrl).href;
  const manifest = validateManifest(options.assetManifest);
  const now = options.now ?? Date.now;
  const stagingTtlMs = options.stagingTtlMs ?? DEFAULT_STAGING_TTL_MS;
  if (!Number.isSafeInteger(stagingTtlMs) || stagingTtlMs <= 0) throw new TypeError("Staging TTL must be positive.");
  const randomShareId = options.randomShareId ?? (() => randomBytes(16).toString("hex"));
  const locks = new KeyedMutex();

  async function reserve(identity: VerifiedShareIdentity, rawInput: ShareAttemptInput): Promise<ReserveResult> {
    validateOwnerHash(identity.ownerHash);
    const input = validateAttemptInput(rawInput);
    const fingerprint = canonicalFingerprint(input);
    const existing = await options.repository.findAttempt(identity.ownerHash, input.attemptId);
    if (existing) {
      if (existing.status === "deleted") throw new ShareServiceError(409, "attempt_closed");
      if (existing.fingerprint !== fingerprint) throw new ShareServiceError(409, "attempt_conflict");
      return toReserveResult(existing, origin);
    }
    for (let collision = 0; collision < 8; collision += 1) {
      const shareId = randomShareId();
      if (typeof shareId !== "string" || !/^[a-f0-9]{32}$/u.test(shareId)) throw new Error("Share ID generator returned an invalid ID.");
      const createdAtMs = now();
      const expiresAt = new Date(createdAtMs + stagingTtlMs).toISOString();
      const stagingKey = `staging/${SHARE_VERSION}/${shareId}.jsonl`;
      const finalKey = `snapshots/${SHARE_VERSION}/${shareId}.jsonl`;
      let uploadPolicy: UploadPolicy;
      try {
        uploadPolicy = await options.objectStore.createUploadPolicy({ key: stagingKey, maxBytes: MAX_SNAPSHOT_BYTES, expiresAt });
      } catch {
        throw new ShareServiceError(503, "storage_unavailable");
      }
      const recordBase = {
        shareId,
        version: SHARE_VERSION,
        ownerHash: identity.ownerHash,
        attemptId: input.attemptId,
        fingerprint,
        sourceThreadId: input.sourceThreadId,
        title: input.title,
        createdAt: new Date(createdAtMs).toISOString(),
        status: "reserved" as const,
        stagingKey,
        finalKey,
        uploadPolicy: clonePolicy(uploadPolicy),
        byteLength: input.byteLength,
        lineCount: input.lineCount,
        snapshotSha256: input.snapshotSha256,
        assetManifest: manifest,
        pageRequestCount: 0,
        installClickCount: 0,
      };
      const record: ShareRecord = input.projectName === undefined
        ? recordBase
        : { ...recordBase, projectName: input.projectName };
      if (await options.repository.putIfAbsent(record)) return toReserveResult(record, origin);
      const raced = await options.repository.findAttempt(identity.ownerHash, input.attemptId);
      if (raced) {
        if (raced.status === "deleted") throw new ShareServiceError(409, "attempt_closed");
        if (raced.fingerprint !== fingerprint) throw new ShareServiceError(409, "attempt_conflict");
        return toReserveResult(raced, origin);
      }
    }
    throw new ShareServiceError(503, "share_id_unavailable");
  }

  async function finalize(identity: VerifiedShareIdentity, shareId: string): Promise<FinalizeResult> {
    validateOwnerHash(identity.ownerHash);
    validateShareId(shareId);
    return locks.run(`finalize:${shareId}`, async () => {
      const current = await options.repository.findShare(shareId);
      if (!current || current.ownerHash !== identity.ownerHash || current.status === "deleted") return notFound();
      if (current.status === "published") return toFinalizeResult(current, origin, "already-created");
      let staged: StoredShareObject | null;
      try {
        staged = await options.objectStore.read(current.stagingKey);
      } catch {
        throw new ShareServiceError(503, "storage_unavailable");
      }
      if (!staged) throw new ShareServiceError(422, "staged_snapshot_missing");
      const validated = validateSnapshotBytes(staged.bytes);
      if (validated.byteLength !== current.byteLength || validated.lineCount !== current.lineCount || validated.sha256 !== current.snapshotSha256) {
        throw new ShareServiceError(422, "snapshot_mismatch");
      }
      let copied: StoredShareObject;
      try {
        copied = await options.objectStore.copyIfMatch({
          sourceKey: current.stagingKey,
          destinationKey: current.finalKey,
          sourceEtag: staged.etag,
          sourceVersionId: staged.versionId,
        });
      } catch (error) {
        if (error instanceof ObjectStoreError && error.code === "precondition_failed") {
          throw new ShareServiceError(409, "staged_snapshot_changed");
        }
        if (error instanceof ObjectStoreError && error.code === "destination_exists") {
          const raced = await options.repository.findShare(shareId);
          if (raced?.ownerHash === identity.ownerHash && raced.status === "published") {
            return toFinalizeResult(raced, origin, "already-created");
          }
          throw new ShareServiceError(409, "finalization_in_progress");
        }
        throw new ShareServiceError(503, "storage_unavailable");
      }
      const publishedAtMs = now();
      const decision = await options.repository.publishIfEligible({
        ownerHash: identity.ownerHash,
        shareId,
        fingerprint: current.fingerprint,
        snapshotEtag: copied.etag,
        snapshotVersionId: copied.versionId,
        byteLength: validated.byteLength,
        lineCount: validated.lineCount,
        publishedAt: new Date(publishedAtMs).toISOString(),
        publishedDay: utcDay(publishedAtMs),
        quotaResetAt: nextUtcMidnight(publishedAtMs),
      }).catch(async () => {
        await options.objectStore.delete(current.finalKey).catch(() => undefined);
        throw new ShareServiceError(503, "storage_unavailable");
      });
      if (decision.kind === "not-found") {
        await options.objectStore.delete(current.finalKey).catch(() => undefined);
        return notFound();
      }
      if (decision.kind === "quota-exhausted") {
        await options.objectStore.delete(current.finalKey).catch(() => undefined);
        throw new ShareServiceError(429, "daily_quota_exhausted", { resetAt: decision.resetAt, used: decision.used, limit: decision.limit });
      }
      await options.objectStore.delete(current.stagingKey).catch(() => undefined);
      return toFinalizeResult(decision.record, origin, decision.kind === "already-published" ? "already-created" : "created");
    });
  }

  async function list(identity: VerifiedShareIdentity): Promise<readonly ShareListItem[]> {
    validateOwnerHash(identity.ownerHash);
    return (await options.repository.listPublished(identity.ownerHash)).map((record) => toListItem(record, origin));
  }

  async function publicPage(shareId: string): Promise<PublicPageResult> {
    validateShareId(shareId);
    const record = await options.repository.findShare(shareId);
    if (!record || record.status !== "published") return notFound();
    let object: StoredShareObject | null;
    try {
      object = await options.objectStore.read(record.finalKey);
    } catch {
      throw new ShareServiceError(503, "storage_unavailable");
    }
    if (!object || object.etag !== record.snapshotEtag || object.versionId !== record.snapshotVersionId) return notFound();
    await options.repository.incrementPageRequest(shareId).catch(() => undefined);
    const base = {
      shareId,
      title: record.title,
      createdAt: record.createdAt,
      snapshotBytes: new Uint8Array(object.bytes),
      assetManifest: cloneManifest(record.assetManifest),
    };
    if (record.projectName === undefined) return Object.freeze(base);
    return Object.freeze({ ...base, projectName: record.projectName });
  }

  async function install(shareId: string): Promise<InstallResult> {
    validateShareId(shareId);
    const record = await options.repository.findShare(shareId);
    if (!record || record.status !== "published") return notFound();
    await options.repository.incrementInstallClick(shareId).catch(() => undefined);
    return Object.freeze({ shareId, location: installUrl });
  }

  async function invalidatePage(shareId: string): Promise<void> {
    validateShareId(shareId);
    await options.pageCache?.invalidate(shareId);
  }

  async function authenticate(request: ShareHttpRequest): Promise<VerifiedShareIdentity> {
    return options.authenticator.verifyBearer(headerValue(request.headers, "authorization"));
  }

  async function handle(request: ShareHttpRequest): Promise<ShareHttpResponse> {
    try {
      const url = new URL(request.path, "https://share.local");
      const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
      if (request.method === "POST" && parts.length === 1 && parts[0] === "shares") {
        const identity = await authenticate(request);
        const body = parseBody(request.body);
        const headerAttempt = headerValue(request.headers, "idempotency-key");
        const inputBase: ShareAttemptInput = {
          attemptId: typeof body.attemptId === "string" ? body.attemptId : headerAttempt ?? "",
          sourceThreadId: typeof body.sourceThreadId === "string" ? body.sourceThreadId : "",
          title: typeof body.title === "string" ? body.title : "",
          byteLength: typeof body.byteLength === "number" ? body.byteLength : -1,
          lineCount: typeof body.lineCount === "number" ? body.lineCount : -1,
          snapshotSha256: typeof body.snapshotSha256 === "string" ? body.snapshotSha256 : "",
        };
        const input: ShareAttemptInput = typeof body.projectName === "string"
          ? { ...inputBase, projectName: body.projectName }
          : inputBase;
        return jsonResponse(200, await reserve(identity, input));
      }
      if (request.method === "POST" && parts.length === 3 && parts[0] === "shares" && parts[2] === "finalize") {
        const identity = await authenticate(request);
        return jsonResponse(200, await finalize(identity, parts[1]!));
      }
      if (request.method === "GET" && parts.length === 1 && parts[0] === "shares") {
        const identity = await authenticate(request);
        return jsonResponse(200, { items: await list(identity) });
      }
      if (request.method === "GET" && parts.length === 2 && parts[0] === "shares") {
        const identity = await authenticate(request);
        const record = await options.repository.findShare(parts[1]!);
        if (!record || record.ownerHash !== identity.ownerHash || record.status !== "published") return notFound();
        return jsonResponse(200, toListItem(record, origin));
      }
      if (request.method === "GET" && parts.length === 2 && parts[0] === "t") {
        const page = await publicPage(parts[1]!);
        if (options.renderPublicPage) {
          return Object.freeze({
            status: 200,
            headers: Object.freeze({
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
            }),
            body: options.renderPublicPage(page),
          });
        }
        return jsonResponse(200, page);
      }
      if (request.method === "GET" && parts.length === 3 && parts[0] === "t" && parts[2] === "install") {
        const result = await install(parts[1]!);
        return Object.freeze({
          status: 302,
          headers: Object.freeze({ location: result.location, "cache-control": "no-store" }),
          body: null,
        });
      }
      return jsonResponse(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ShareServiceError) return jsonResponse(error.status, { error: error.code, ...error.data });
      if (error instanceof URIError) return jsonResponse(404, { error: "not_found" });
      return jsonResponse(500, { error: "service_unavailable" });
    }
  }

  return Object.freeze({ reserve, finalize, list, publicPage, install, invalidatePage, handle });
}

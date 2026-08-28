import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DESKTOP_ACCOUNT_PORTS = Object.freeze({
  stable: Object.freeze([49152, 49153, 49154]),
  preview: Object.freeze([49155, 49156, 49157]),
});

export const GRAPHCOMPLETE_AUTH0 = Object.freeze({
  issuer: "https://auth.relayerlabs.ai/",
  clientId: "cRrFcqK4Gf16pkI2Jn5K5sIwQj7VsLNj",
});

export const GRAPHCOMPLETE_LOGIN_URL = "https://app.relayerlabs.ai/desktop/login";

const CALLBACK_PATH = "/auth/callback";
const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

class UnverifiableTokenError extends Error {}
class OfflineAuthError extends Error {}
class InvalidRefreshError extends Error {}

function publicState(channel, status, details = {}) {
  return Object.freeze({ status, channel, ...details });
}

function decodeJsonBase64Url(value, label) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new UnverifiableTokenError(`Invalid ${label}.`);
  }
}

function normalizeAudience(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function exactTokenResponse(value) {
  if (!value || typeof value !== "object") throw new UnverifiableTokenError("Auth0 returned no token response.");
  if (value.token_type !== "Bearer" || typeof value.id_token !== "string" || !value.id_token) {
    throw new UnverifiableTokenError("Auth0 returned an invalid token response.");
  }
  if (value.refresh_token != null && (typeof value.refresh_token !== "string" || !value.refresh_token)) {
    throw new UnverifiableTokenError("Auth0 returned an invalid refresh credential.");
  }
  return value;
}

async function bindLoopback(handler, ports) {
  let lastError;
  for (const port of ports) {
    const server = createServer(handler);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return { server, port };
    } catch (error) {
      lastError = error;
      server.close();
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") throw error;
    }
  }
  throw new AggregateError(lastError ? [lastError] : [], "No registered desktop sign-in callback port is available.");
}

function closeServer(server, { wait = true } = {}) {
  if (!server?.listening) return Promise.resolve();
  // Stop accepting a second callback immediately. Do not await the close
  // callback from inside the active callback request: HTTP keep-alive would
  // otherwise make the request wait on its own socket.
  if (wait) return new Promise((resolve) => server.close(resolve));
  server.close();
  server.closeIdleConnections?.();
  return Promise.resolve();
}

export function createDesktopAccountService({
  channel: initialChannel,
  credentialPath,
  encrypt,
  decrypt,
  openExternal,
  auth0 = GRAPHCOMPLETE_AUTH0,
  launcherUrl = GRAPHCOMPLETE_LOGIN_URL,
  portsByChannel = DESKTOP_ACCOUNT_PORTS,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = LOGIN_TIMEOUT_MS,
  emit = () => {},
  beforeCredentialCommit = async () => {},
}) {
  if (initialChannel !== "stable" && initialChannel !== "preview") throw new TypeError("Desktop account channel must be stable or preview.");
  for (const candidate of ["stable", "preview"]) {
    const candidatePorts = portsByChannel[candidate];
    if (!Array.isArray(candidatePorts) || candidatePorts.length === 0 || !candidatePorts.every(Number.isInteger)) {
      throw new TypeError(`Desktop account ${candidate} callback ports are required.`);
    }
  }
  if (typeof credentialPath !== "string" || !credentialPath) throw new TypeError("Desktop account credential path is required.");
  if (typeof encrypt !== "function" || typeof decrypt !== "function") throw new TypeError("Desktop account encryption is required.");
  if (typeof openExternal !== "function") throw new TypeError("Desktop account browser authority is required.");
  const issuer = new URL(auth0.issuer).href;
  if (!issuer.endsWith("/")) throw new TypeError("Auth0 issuer must end with a slash.");
  if (typeof auth0.clientId !== "string" || !auth0.clientId) throw new TypeError("Auth0 public client ID is required.");

  let currentChannel = initialChannel;
  let state = publicState(currentChannel, "signed-out");
  let generation = 0;
  let credential = null;
  let attempt = null;
  let startupPromise;
  let jwksPromise;
  let pendingCredentialMutation = Promise.resolve();
  let pendingControlOperation = Promise.resolve();

  function queueCredentialMutation(operation) {
    const result = pendingCredentialMutation.then(operation, operation);
    pendingCredentialMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  function queueControlOperation(operation) {
    const result = pendingControlOperation.then(operation, operation);
    pendingControlOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  function transition(next) {
    state = next;
    emit(next);
    return next;
  }

  async function readCredential() {
    await pendingCredentialMutation;
    let envelope;
    try {
      envelope = JSON.parse(await readFile(credentialPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (envelope?.version !== 1 || !Number.isSafeInteger(envelope.generation) || envelope.generation < 0 || typeof envelope.sealed !== "string") {
      throw new Error("Invalid desktop account credential envelope.");
    }
    const plaintext = JSON.parse(await decrypt(envelope.sealed));
    if (typeof plaintext?.refreshToken !== "string" || !plaintext.refreshToken || typeof plaintext?.subject !== "string" || !plaintext.subject) {
      throw new Error("Invalid desktop account credential payload.");
    }
    generation = Math.max(generation, envelope.generation);
    return { refreshToken: plaintext.refreshToken, subject: plaintext.subject };
  }

  async function writeCredential(value, atGeneration) {
    const sealed = await encrypt(JSON.stringify(value));
    if (typeof sealed !== "string" || !sealed) throw new Error("Desktop account encryption returned no value.");
    return queueCredentialMutation(async () => {
      if (generation !== atGeneration) return false;
      await mkdir(dirname(credentialPath), { recursive: true });
      const temporaryPath = `${credentialPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify({ version: 1, generation: atGeneration, sealed }, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await beforeCredentialCommit();
        if (generation !== atGeneration) return false;
        await rename(temporaryPath, credentialPath);
        return generation === atGeneration;
      } finally {
        await rm(temporaryPath, { force: true });
      }
    });
  }

  function removeCredential() {
    return queueCredentialMutation(() => rm(credentialPath, { force: true }));
  }

  async function fetchJson(url, options) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new OfflineAuthError("Auth0 is unavailable.", { cause: error });
    }
    const body = await responseJson(response);
    if (!response.ok) {
      if (body?.error === "invalid_grant") throw new InvalidRefreshError("Refresh credential is no longer valid.");
      throw new OfflineAuthError("Auth0 request failed.");
    }
    return body;
  }

  async function jwks() {
    jwksPromise ??= fetchJson(new URL(".well-known/jwks.json", issuer), { headers: { accept: "application/json" } })
      .then((body) => {
        if (!Array.isArray(body?.keys)) throw new UnverifiableTokenError("Auth0 returned no signing keys.");
        return body.keys;
      })
      .catch((error) => {
        jwksPromise = undefined;
        throw error;
      });
    return jwksPromise;
  }

  async function verifyIdToken(token) {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) throw new UnverifiableTokenError("Invalid ID token.");
    const header = decodeJsonBase64Url(parts[0], "ID token header");
    const claims = decodeJsonBase64Url(parts[1], "ID token claims");
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new UnverifiableTokenError("Unsupported ID token signature.");
    const key = (await jwks()).find((candidate) => candidate?.kid === header.kid && candidate?.kty === "RSA");
    if (!key) throw new UnverifiableTokenError("ID token signing key is unknown.");
    let validSignature = false;
    try {
      validSignature = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"));
    } catch {}
    const audiences = normalizeAudience(claims.aud);
    const nowSeconds = Math.floor(now() / 1000);
    if (!validSignature || claims.iss !== issuer || !audiences.includes(auth0.clientId) ||
        (claims.azp != null && claims.azp !== auth0.clientId) ||
        (audiences.length > 1 && claims.azp !== auth0.clientId) ||
        typeof claims.exp !== "number" || !Number.isInteger(claims.exp) || claims.exp <= nowSeconds ||
        typeof claims.sub !== "string" || !claims.sub) {
      throw new UnverifiableTokenError("ID token claims are invalid.");
    }
    return claims.sub;
  }

  async function tokenRequest(parameters) {
    const body = await fetchJson(new URL("oauth/token", issuer), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(parameters),
    });
    const tokens = exactTokenResponse(body);
    return { tokens, subject: await verifyIdToken(tokens.id_token) };
  }

  async function refresh(saved, atGeneration) {
    const { tokens, subject } = await tokenRequest({
      grant_type: "refresh_token",
      client_id: auth0.clientId,
      refresh_token: saved.refreshToken,
    });
    if (generation !== atGeneration) return state;
    if (subject !== saved.subject) throw new UnverifiableTokenError("Refresh credential changed account subject.");
    const nextCredential = { refreshToken: tokens.refresh_token ?? saved.refreshToken, subject };
    if (!await writeCredential(nextCredential, atGeneration)) return state;
    credential = nextCredential;
    return transition(publicState(currentChannel, "signed-in", { subject }));
  }

  async function cancelAttempt() {
    if (!attempt) return;
    const current = attempt;
    attempt = null;
    clearTimeout(current.timer);
    await closeServer(current.server);
    current.resolve(state);
  }

  async function finishAttempt(current, nextState) {
    if (attempt !== current) return state;
    attempt = null;
    clearTimeout(current.timer);
    await closeServer(current.server, { wait: false });
    const result = generation === current.generation ? transition(nextState) : state;
    current.resolve(result);
    return result;
  }

  function callbackHandler(currentRef) {
    return async (request, response) => {
      response.setHeader("connection", "close");
      const current = currentRef.current;
      if (!current || attempt !== current || generation !== current.generation) {
        response.statusCode = 410;
        response.end("This sign-in attempt is no longer active.");
        return;
      }
      const url = new URL(request.url, current.redirectUri);
      const callback = new URL(current.redirectUri);
      if (request.method !== "GET" || request.headers.host !== callback.host ||
          url.origin !== callback.origin || url.pathname !== CALLBACK_PATH) {
        response.statusCode = 400;
        response.end("Sign-in could not be verified.");
        await finishAttempt(current, publicState(current.channel, "error", { reason: "authentication-failed" }));
        return;
      }
      const keys = [...url.searchParams.keys()];
      const stateMatches = url.searchParams.get("state") === current.state;
      const code = url.searchParams.get("code");
      const hasAuthError = url.searchParams.has("error");
      const authError = url.searchParams.get("error");
      const keyCount = (key) => keys.filter((candidate) => candidate === key).length;
      const validErrorShape = hasAuthError
        && Boolean(authError)
        && keyCount("error") === 1
        && keyCount("state") === 1
        && keyCount("error_description") <= 1
        && keys.length === 2 + keyCount("error_description");
      const validCodeShape = !hasAuthError
        && Boolean(code)
        && keyCount("code") === 1
        && keyCount("state") === 1
        && keys.length === 2;
      if (!stateMatches || (!validErrorShape && !validCodeShape)) {
        response.statusCode = 400;
        response.end("Sign-in could not be verified.");
        await finishAttempt(current, publicState(current.channel, "error", { reason: "authentication-failed" }));
        return;
      }
      if (hasAuthError) {
        response.statusCode = 400;
        response.end("Sign-in was cancelled or rejected.");
        await finishAttempt(current, publicState(current.channel, "signed-out"));
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Sign-in received. You can return to Relayer.");
      await closeServer(current.server, { wait: false });
      try {
        const { tokens, subject } = await tokenRequest({
          grant_type: "authorization_code",
          client_id: auth0.clientId,
          code,
          code_verifier: current.verifier,
          redirect_uri: current.redirectUri,
        });
        if (attempt !== current || generation !== current.generation) return;
        if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) throw new UnverifiableTokenError("Auth0 returned no rotating refresh credential.");
        const nextCredential = { refreshToken: tokens.refresh_token, subject };
        if (!await writeCredential(nextCredential, current.generation) ||
            attempt !== current || generation !== current.generation) return;
        credential = nextCredential;
        await finishAttempt(current, publicState(current.channel, "signed-in", { subject }));
      } catch {
        await finishAttempt(current, publicState(current.channel, "error", { reason: "authentication-failed" }));
      }
    };
  }

  return Object.freeze({
    async start() {
      startupPromise ??= (async () => {
        try {
          credential = await readCredential();
        } catch {
          return transition(publicState(currentChannel, "error", { reason: "storage-unavailable" }));
        }
        if (!credential) return state;
        const atGeneration = generation;
        try {
          return await refresh(credential, atGeneration);
        } catch (error) {
          if (error instanceof InvalidRefreshError) {
            generation += 1;
            credential = null;
            await removeCredential();
            return transition(publicState(currentChannel, "signed-out"));
          }
          const reason = error instanceof UnverifiableTokenError ? "unverifiable" : "offline";
          return transition(publicState(currentChannel, "uncertain", { subject: credential.subject, reason }));
        }
      })();
      return startupPromise;
    },

    async account() {
      await startupPromise;
      return state;
    },

    async setChannel(nextChannel) {
      return queueControlOperation(async () => {
        await startupPromise;
        if (nextChannel !== "stable" && nextChannel !== "preview") {
          throw new TypeError("Desktop account channel must be stable or preview.");
        }
        if (nextChannel === currentChannel) return state;
        generation += 1;
        await cancelAttempt();
        currentChannel = nextChannel;
        if (state.status === "signed-in" && credential) {
          return transition(publicState(currentChannel, "signed-in", { subject: credential.subject }));
        }
        if (state.status === "uncertain" && credential) {
          return transition(publicState(currentChannel, "uncertain", {
            subject: credential.subject,
            reason: state.reason,
          }));
        }
        if (state.status === "error") {
          return transition(publicState(currentChannel, "error", { reason: state.reason }));
        }
        return transition(publicState(currentChannel, "signed-out"));
      });
    },

    telemetryIdentity() {
      return state.status === "signed-in" && credential
        ? Object.freeze({ generation, subject: credential.subject })
        : null;
    },

    async login() {
      return queueControlOperation(async () => {
        await startupPromise;
        generation += 1;
        await cancelAttempt();
        const atGeneration = generation;
        const attemptChannel = currentChannel;
        const stateValue = randomBytes(32).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const currentRef = { current: null };
        let bound;
        try {
          bound = await bindLoopback(callbackHandler(currentRef), portsByChannel[attemptChannel]);
        } catch {
          return transition(publicState(attemptChannel, "error", { reason: "authentication-failed" }));
        }
        const redirectUri = `http://127.0.0.1:${bound.port}${CALLBACK_PATH}`;
        let resolveIdle;
        const idle = new Promise((resolve) => { resolveIdle = resolve; });
        const current = {
          generation: atGeneration,
          channel: attemptChannel,
          state: stateValue,
          verifier,
          redirectUri,
          server: bound.server,
          resolve: resolveIdle,
          idle,
          timer: null,
        };
        currentRef.current = current;
        attempt = current;
        current.timer = setTimeout(() => {
          void finishAttempt(current, publicState(attemptChannel, "error", { reason: "authentication-failed" }));
        }, timeoutMs);
        transition(publicState(attemptChannel, "signing-in"));
        const launch = new URL(launcherUrl);
        launch.search = new URLSearchParams({
          channel: attemptChannel,
          redirect_uri: redirectUri,
          state: stateValue,
          code_challenge: challenge,
        }).toString();
        try {
          await openExternal(launch.href);
        } catch {
          await finishAttempt(current, publicState(attemptChannel, "error", { reason: "authentication-failed" }));
        }
        return state;
      });
    },

    async logout() {
      return queueControlOperation(async () => {
        await startupPromise;
        generation += 1;
        await cancelAttempt();
        const retiring = credential;
        credential = null;
        transition(publicState(currentChannel, "signed-out"));
        await removeCredential();
        if (retiring?.refreshToken) {
          try {
            await fetchJson(new URL("oauth/revoke", issuer), {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ client_id: auth0.clientId, token: retiring.refreshToken }),
            });
          } catch {}
        }
        return state;
      });
    },

    async waitForIdle() {
      const current = attempt;
      return current ? current.idle : state;
    },

    async close() {
      return queueControlOperation(async () => {
        generation += 1;
        await cancelAttempt();
        await pendingCredentialMutation;
      });
    },
  });
}

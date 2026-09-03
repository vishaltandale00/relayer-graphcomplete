import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopAccountService,
  DESKTOP_ACCOUNT_PORTS,
} from "../desktop/main/services/desktop-account-service.mjs";
import { registerDesktopIpc } from "../desktop/main/ipc/register-ipc.mjs";

const directories = [];
const servers = [];

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function idToken({ privateKey, issuer, clientId, subject = "auth0|person", expiresAt, kid = "test-key", azp }) {
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const encodedPayload = base64url(JSON.stringify({
    iss: issuer,
    aud: clientId,
    sub: subject,
    iat: expiresAt - 600,
    exp: expiresAt,
    ...(azp === undefined ? {} : { azp }),
  }));
  const input = `${encodedHeader}.${encodedPayload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

async function listen(server, host = "127.0.0.1", port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  servers.push(server);
  return server.address().port;
}

async function fakeAuth0({ clientId = "desktop-client", tokenHandler } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const requests = [];
  let issuer;
  const server = createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      let value = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { value += chunk; });
      request.on("end", () => resolve(value));
    });
    requests.push({ url: request.url, method: request.method, body: new URLSearchParams(body) });
    if (request.url === "/.well-known/jwks.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "RS256" }] }));
      return;
    }
    if (request.url === "/oauth/revoke") {
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.url === "/oauth/token") {
      const custom = await tokenHandler?.({ body: new URLSearchParams(body), requests, issuer, privateKey });
      response.statusCode = custom?.status ?? 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(custom?.json ?? {
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rotated-refresh-token",
        id_token: idToken({ privateKey, issuer, clientId, expiresAt: 2_000_000_000 }),
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const port = await listen(server);
  issuer = `http://127.0.0.1:${port}/`;
  return { issuer, clientId, requests, privateKey };
}

async function fixture({ auth0, channel = "stable", portsByChannel, openExternal, now = () => 1_900_000_000_000, timeoutMs = 2_000, beforeCredentialCommit, telemetry, emit, presentWindow } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relayer-account-"));
  directories.push(directory);
  const encrypted = [];
  const service = createDesktopAccountService({
    channel,
    portsByChannel,
    credentialPath: join(directory, "account.json"),
    auth0: { issuer: auth0.issuer, clientId: auth0.clientId },
    launcherUrl: "https://app.relayerlabs.ai/desktop/login",
    encrypt: async (value) => {
      encrypted.push(value);
      return Buffer.from(`sealed:${value}`).toString("base64");
    },
    decrypt: async (value) => {
      const plaintext = Buffer.from(value, "base64").toString("utf8");
      if (!plaintext.startsWith("sealed:")) throw new Error("not sealed");
      return plaintext.slice(7);
    },
    openExternal: openExternal ?? vi.fn(async () => {}),
    now,
    timeoutMs,
    beforeCredentialCommit,
    telemetry,
    emit,
    presentWindow,
  });
  return { directory, service, encrypted };
}

async function callbackFromLauncher(url, overrides = {}) {
  const launcher = new URL(url);
  const callback = new URL(launcher.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({
    code: "authorization-code",
    state: launcher.searchParams.get("state"),
    ...overrides,
  });
  return fetch(callback);
}

async function cancellationFromLauncher(url) {
  const launcher = new URL(url);
  const callback = new URL(launcher.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({
    error: "access_denied",
    error_description: "The user cancelled sign-in.",
    state: launcher.searchParams.get("state"),
  });
  return fetch(callback);
}

function rawCallback(url, { method = "GET", host, path } = {}) {
  const callback = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: callback.port,
      path: path ?? `${callback.pathname}${callback.search}`,
      method,
      headers: { host: host ?? callback.host },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.sequential("desktop direct Auth0 account authority", () => {
  it("binds a channel callback before browser launch and exchanges one valid callback with PKCE", async () => {
    const auth0 = await fakeAuth0();
    let boundDuringOpen = false;
    let launchUrl;
    const { service, directory, encrypted } = await fixture({
      auth0,
      openExternal: vi.fn(async (value) => {
        launchUrl = value;
        const callback = new URL(new URL(value).searchParams.get("redirect_uri"));
        boundDuringOpen = await new Promise((resolve) => {
          const probe = createServer();
          probe.once("error", () => resolve(true));
          probe.listen(Number(callback.port), "127.0.0.1", () => probe.close(() => resolve(false)));
        });
      }),
    });

    await expect(service.start()).resolves.toEqual({ status: "signed-out", channel: "stable" });
    await expect(service.login()).resolves.toEqual({ status: "signing-in", channel: "stable" });
    expect(boundDuringOpen).toBe(true);
    const launcher = new URL(launchUrl);
    expect(launcher.origin + launcher.pathname).toBe("https://app.relayerlabs.ai/desktop/login");
    expect(launcher.searchParams.get("channel")).toBe("stable");
    expect(new URL(launcher.searchParams.get("redirect_uri")).port).toBe("49152");
    expect(launcher.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43,256}$/);
    expect(launcher.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const callback = await callbackFromLauncher(launchUrl);
    expect(callback.status).toBe(200);
    await expect(service.waitForIdle()).resolves.toEqual({
      status: "signed-in", channel: "stable", subject: "auth0|person",
    });
    const admittedGeneration = service.telemetryIdentity();
    expect(admittedGeneration).toEqual({ generation: 1, subject: "auth0|person" });
    const tokenRequest = auth0.requests.find(({ url }) => url === "/oauth/token");
    expect(Object.fromEntries(tokenRequest.body)).toMatchObject({
      grant_type: "authorization_code",
      client_id: "desktop-client",
      code: "authorization-code",
      redirect_uri: "http://127.0.0.1:49152/auth/callback",
    });
    const verifier = tokenRequest.body.get("code_verifier");
    expect(createHash("sha256").update(verifier).digest("base64url"))
      .toBe(launcher.searchParams.get("code_challenge"));
    expect(JSON.stringify(await service.account())).not.toMatch(/token|verifier|code|state|issuer|client/i);
    expect(encrypted.at(-1)).toContain("rotated-refresh-token");
    expect(await readFile(join(directory, "account.json"), "utf8")).not.toContain("rotated-refresh-token");
    await expect(callbackFromLauncher(launchUrl)).rejects.toThrow();
    await service.close();
  });

  it("brings Relayer back for every settled callback and leaves a superseded one in the browser", async () => {
    const auth0 = await fakeAuth0();
    let launchUrl;
    const openExternal = async (value) => { launchUrl = value; };

    // Success: the user finished in the browser, so the app comes forward.
    const succeededPresent = vi.fn();
    const succeeded = await fixture({ auth0, openExternal, presentWindow: succeededPresent });
    await succeeded.service.start();
    await succeeded.service.login();
    expect(succeededPresent).not.toHaveBeenCalled();
    expect((await callbackFromLauncher(launchUrl)).status).toBe(200);
    await expect(succeeded.service.waitForIdle()).resolves.toMatchObject({ status: "signed-in" });
    expect(succeededPresent).toHaveBeenCalledOnce();
    await succeeded.service.close();

    // Cancellation: the error belongs in the app, not in a browser tab.
    const cancelledPresent = vi.fn();
    const cancelled = await fixture({ auth0, openExternal, presentWindow: cancelledPresent });
    await cancelled.service.start();
    await cancelled.service.login();
    expect((await cancellationFromLauncher(launchUrl)).status).toBe(400);
    await expect(cancelled.service.waitForIdle()).resolves.toEqual({ status: "signed-out", channel: "stable" });
    expect(cancelledPresent).toHaveBeenCalledOnce();
    await cancelled.service.close();

    // A callback that does carry this attempt's state but is malformed is this
    // attempt's business, so it still fails closed and still returns.
    const malformedPresent = vi.fn();
    const malformed = await fixture({ auth0, openExternal, presentWindow: malformedPresent });
    await malformed.service.start();
    await malformed.service.login();
    const malformedCallback = new URL(new URL(launchUrl).searchParams.get("redirect_uri"));
    malformedCallback.search = new URLSearchParams({
      state: new URL(launchUrl).searchParams.get("state"),
      code: "authorization-code",
      extra: "unexpected",
    });
    expect(await rawCallback(malformedCallback)).toBe(400);
    await expect(malformed.service.waitForIdle()).resolves.toMatchObject({ status: "error" });
    expect(malformedPresent).toHaveBeenCalledOnce();
    await malformed.service.close();

    // Nothing came back from the browser, so nothing yanks the user out of
    // whatever they moved on to while the attempt aged out.
    const timedOutPresent = vi.fn();
    const timedOut = await fixture({ auth0, openExternal, timeoutMs: 10, presentWindow: timedOutPresent });
    await timedOut.service.start();
    await timedOut.service.login();
    await expect(timedOut.service.waitForIdle()).resolves.toMatchObject({ status: "error" });
    expect(timedOutPresent).not.toHaveBeenCalled();
    await timedOut.service.close();
  });

  it("survives a window that cannot be presented", async () => {
    const auth0 = await fakeAuth0();
    let launchUrl;
    const { service } = await fixture({
      auth0,
      openExternal: async (value) => { launchUrl = value; },
      presentWindow: () => { throw new Error("window is gone"); },
    });
    await service.start();
    await service.login();
    expect((await callbackFromLauncher(launchUrl)).status).toBe(200);
    await expect(service.waitForIdle()).resolves.toMatchObject({ status: "signed-in" });
    await service.close();
  });

  it("falls through occupied ports only inside the selected channel pool", async () => {
    const auth0 = await fakeAuth0();
    const blocker = createServer();
    await listen(blocker, "127.0.0.1", DESKTOP_ACCOUNT_PORTS.preview[0]);
    let launchUrl;
    const { service } = await fixture({
      auth0,
      channel: "preview",
      openExternal: async (value) => { launchUrl = value; },
    });
    await service.start();
    await service.login();
    expect(new URL(new URL(launchUrl).searchParams.get("redirect_uri")).port).toBe("49156");
    expect(launchUrl).not.toContain("49152");
    await service.logout();
    await service.close();
  });

  it("switches authoritative channel pools and preserves a verified account", async () => {
    const auth0 = await fakeAuth0();
    let launchUrl;
    const { service } = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
    await service.start();
    await expect(service.setChannel("preview")).resolves.toEqual({ status: "signed-out", channel: "preview" });
    await service.login();
    expect(new URL(new URL(launchUrl).searchParams.get("redirect_uri")).port).toBe("49155");
    await callbackFromLauncher(launchUrl);
    await service.waitForIdle();
    await expect(service.setChannel("stable")).resolves.toEqual({
      status: "signed-in", channel: "stable", subject: "auth0|person",
    });
    expect(service.telemetryIdentity()).toMatchObject({ subject: "auth0|person" });
    await service.login();
    expect(new URL(new URL(launchUrl).searchParams.get("redirect_uri")).port).toBe("49152");
    await service.logout();
    await service.close();
  });

  it("serializes overlapping login attempts behind one listener owner", async () => {
    const auth0 = await fakeAuth0();
    const launches = [];
    let enterFirst;
    let releaseFirst;
    const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const { service } = await fixture({
      auth0,
      openExternal: async (value) => {
        launches.push(value);
        if (launches.length === 1) {
          enterFirst();
          await firstGate;
        }
      },
    });
    await service.start();
    const first = service.login();
    await firstEntered;
    const second = service.login();
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(1);
    releaseFirst();
    await first;
    await second;
    expect(launches).toHaveLength(2);
    expect(new URL(launches[0]).searchParams.get("state"))
      .not.toBe(new URL(launches[1]).searchParams.get("state"));
    await callbackFromLauncher(launches[1]);
    await expect(service.waitForIdle()).resolves.toMatchObject({ status: "signed-in" });
    expect(auth0.requests.filter(({ url }) => url === "/oauth/token")).toHaveLength(1);
    await service.close();
  });

  it("serializes a channel switch after login launch and closes the old listener", async () => {
    const auth0 = await fakeAuth0();
    const launches = [];
    let enterLaunch;
    let releaseLaunch;
    const launchEntered = new Promise((resolve) => { enterLaunch = resolve; });
    const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
    const { service } = await fixture({
      auth0,
      openExternal: async (value) => {
        launches.push(value);
        if (launches.length === 1) {
          enterLaunch();
          await launchGate;
        }
      },
    });
    await service.start();
    const login = service.login();
    await launchEntered;
    const switchChannel = service.setChannel("preview");
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.account()).resolves.toEqual({ status: "signing-in", channel: "stable" });
    releaseLaunch();
    await login;
    await expect(switchChannel).resolves.toEqual({ status: "signed-out", channel: "preview" });
    await expect(callbackFromLauncher(launches[0])).rejects.toThrow();
    await service.login();
    expect(new URL(new URL(launches[1]).searchParams.get("redirect_uri")).port).toBe("49155");
    await service.logout();
    await service.close();
  });

  it("refuses a foreign state without cancelling or presenting the attempt that owns the listener", async () => {
    const auth0 = await fakeAuth0();
    let launchUrl;
    const presentWindow = vi.fn();
    const { service } = await fixture({
      auth0,
      openExternal: async (value) => { launchUrl = value; },
      presentWindow,
    });
    await service.start();
    await service.login();

    // A state this attempt did not issue cannot authenticate, so it is refused.
    // It also is not this attempt's callback, so it must not end it.
    expect((await callbackFromLauncher(launchUrl, { state: randomBytes(32).toString("base64url") })).status).toBe(400);
    expect(await service.account()).toEqual({ status: "signing-in", channel: "stable" });
    expect(presentWindow).not.toHaveBeenCalled();
    expect(auth0.requests.filter(({ url }) => url === "/oauth/token")).toHaveLength(0);

    // The attempt still owns its listener and still completes.
    expect((await callbackFromLauncher(launchUrl)).status).toBe(200);
    await expect(service.waitForIdle()).resolves.toMatchObject({ status: "signed-in" });
    expect(presentWindow).toHaveBeenCalledOnce();
    await service.close();
  });

  it("does not let a replaced login's stale callback cancel or present its replacement", async () => {
    const auth0 = await fakeAuth0();
    const launches = [];
    const presentWindow = vi.fn();
    const { service } = await fixture({
      auth0,
      openExternal: async (value) => { launches.push(value); },
      presentWindow,
    });
    await service.start();
    await service.login();
    await service.login();
    expect(launches).toHaveLength(2);
    const [first, second] = launches;
    // Same loopback port, different state: the replacement owns the listener.
    expect(new URL(new URL(first).searchParams.get("redirect_uri")).port)
      .toBe(new URL(new URL(second).searchParams.get("redirect_uri")).port);

    expect((await callbackFromLauncher(first)).status).toBe(400);
    expect(await service.account()).toEqual({ status: "signing-in", channel: "stable" });
    expect(presentWindow).not.toHaveBeenCalled();
    expect(auth0.requests.filter(({ url }) => url === "/oauth/token")).toHaveLength(0);

    expect((await callbackFromLauncher(second)).status).toBe(200);
    await expect(service.waitForIdle()).resolves.toMatchObject({ status: "signed-in" });
    expect(presentWindow).toHaveBeenCalledOnce();
    await service.close();
  });

  it("refuses a request that is not this attempt's callback without settling or presenting it", async () => {
    const auth0 = await fakeAuth0();
    let launchUrl;
    const presentWindow = vi.fn();
    const { service } = await fixture({
      auth0,
      openExternal: async (value) => { launchUrl = value; },
      presentWindow,
    });
    await service.start();
    await service.login();
    const launcher = new URL(launchUrl);
    const callback = new URL(launcher.searchParams.get("redirect_uri"));
    callback.search = new URLSearchParams({
      code: "authorization-code",
      state: launcher.searchParams.get("state"),
    });
    for (const mutation of [
      // The browser's own probe for the callback page carries no state at all.
      () => ({ path: "/favicon.ico" }),
      (target) => ({ path: `/other${target.search}` }),
      () => ({ method: "POST" }),
      () => ({ host: "attacker.example" }),
    ]) {
      expect(await rawCallback(callback, mutation(callback))).toBe(400);
      expect(await service.account()).toEqual({ status: "signing-in", channel: "stable" });
      expect(presentWindow).not.toHaveBeenCalled();
    }
    expect(auth0.requests.filter(({ url }) => url === "/oauth/token")).toHaveLength(0);

    // None of them disturbed the listener, so the real callback still lands.
    expect((await callbackFromLauncher(launchUrl)).status).toBe(200);
    await expect(service.waitForIdle()).resolves.toMatchObject({ status: "signed-in" });
    expect(presentWindow).toHaveBeenCalledOnce();
    await service.close();
  });

  it("returns to signed out on explicit cancellation and fails closed on timeout", async () => {
    const auth0 = await fakeAuth0();
    let launchUrl;
    const cancelled = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
    await cancelled.service.start();
    await cancelled.service.login();
    expect((await cancellationFromLauncher(launchUrl)).status).toBe(400);
    await expect(cancelled.service.waitForIdle()).resolves.toEqual({ status: "signed-out", channel: "stable" });
    await cancelled.service.close();

    let duplicateLaunchUrl;
    const duplicate = await fixture({
      auth0,
      openExternal: async (value) => { duplicateLaunchUrl = value; },
    });
    await duplicate.service.start();
    await duplicate.service.login();
    const duplicateLauncher = new URL(duplicateLaunchUrl);
    const duplicateCallback = new URL(duplicateLauncher.searchParams.get("redirect_uri"));
    const duplicateState = duplicateLauncher.searchParams.get("state");
    duplicateCallback.search = `error=access_denied&state=${encodeURIComponent(duplicateState)}&state=${encodeURIComponent(duplicateState)}`;
    expect((await fetch(duplicateCallback)).status).toBe(400);
    await expect(duplicate.service.waitForIdle()).resolves.toEqual({
      status: "error", channel: "stable", reason: "authentication-failed",
    });
    await duplicate.service.close();

    const timedOut = await fixture({ auth0, timeoutMs: 10 });
    await timedOut.service.start();
    await timedOut.service.login();
    await expect(timedOut.service.waitForIdle()).resolves.toEqual({
      status: "error", channel: "stable", reason: "authentication-failed",
    });
    await timedOut.service.close();
  });

  it("cannot commit a code exchange after logout invalidates its generation", async () => {
    let releaseExchange;
    const auth0 = await fakeAuth0({ tokenHandler: async () => {
      await new Promise((resolve) => { releaseExchange = resolve; });
      return undefined;
    } });
    let launchUrl;
    const { service, directory } = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
    await service.start();
    await service.login();
    expect((await callbackFromLauncher(launchUrl)).status).toBe(200);
    await vi.waitFor(() => expect(releaseExchange).toBeTypeOf("function"));
    await expect(service.logout()).resolves.toEqual({ status: "signed-out", channel: "stable" });
    releaseExchange();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.account()).resolves.toEqual({ status: "signed-out", channel: "stable" });
    await expect(readFile(join(directory, "account.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await service.close();
  });

  it("serializes logout deletion after an already-started credential commit", async () => {
    const auth0 = await fakeAuth0();
    let releaseCommit;
    let enteredCommit;
    const commitEntered = new Promise((resolve) => { enteredCommit = resolve; });
    let launchUrl;
    const { service, directory } = await fixture({
      auth0,
      openExternal: async (value) => { launchUrl = value; },
      beforeCredentialCommit: async () => {
        enteredCommit();
        await new Promise((resolve) => { releaseCommit = resolve; });
      },
    });
    await service.start();
    await service.login();
    await callbackFromLauncher(launchUrl);
    await commitEntered;
    const logout = service.logout();
    await expect(service.account()).resolves.toEqual({ status: "signing-in", channel: "stable" });
    releaseCommit();
    await logout;
    await expect(service.account()).resolves.toEqual({ status: "signed-out", channel: "stable" });
    await expect(readFile(join(directory, "account.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await service.close();
  });

  it("retires telemetry and credentials before publishing logout and binds each verified generation before signed-in", async () => {
    const auth0 = await fakeAuth0();
    const order = [];
    let launchUrl;
    let signedOutCredentialCheck;
    const telemetry = {
      transitionIdentity: vi.fn(async (identity) => { order.push(identity === null ? "telemetry-disabled" : `telemetry-enabled:${identity.generation}`); }),
      retireIdentity: vi.fn(async () => { order.push("telemetry-retired"); }),
    };
    const { service, directory } = await fixture({
      auth0,
      telemetry,
      openExternal: async (value) => { launchUrl = value; },
      emit: (state) => {
        order.push(`state:${state.status}`);
        if (state.status === "signed-out") {
          signedOutCredentialCheck = readFile(join(directory, "account.json"), "utf8")
            .then(() => ({ exists: true }), (error) => ({ error }));
        }
      },
    });

    await service.start();
    await service.login();
    await callbackFromLauncher(launchUrl);
    await service.waitForIdle();
    expect(order).toContain("telemetry-enabled:1");
    expect(order.indexOf("telemetry-enabled:1")).toBeLessThan(order.indexOf("state:signed-in"));

    order.length = 0;
    await service.logout();
    expect(order).toEqual(["telemetry-retired", "state:signed-out"]);
    await expect(signedOutCredentialCheck).resolves.toMatchObject({ error: { code: "ENOENT" } });
    await service.close();
  });

  it("persists only encrypted rotating refresh material and restores it by direct refresh", async () => {
    const auth0 = await fakeAuth0();
    let launchUrl;
    const first = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
    await first.service.start();
    await first.service.login();
    await callbackFromLauncher(launchUrl);
    await first.service.waitForIdle();
    await first.service.close();

    const second = createDesktopAccountService({
      channel: "stable",
      credentialPath: join(first.directory, "account.json"),
      auth0: { issuer: auth0.issuer, clientId: auth0.clientId },
      launcherUrl: "https://app.relayerlabs.ai/desktop/login",
      encrypt: async (value) => Buffer.from(`sealed:${value}`).toString("base64"),
      decrypt: async (value) => Buffer.from(value, "base64").toString("utf8").slice(7),
      openExternal: async () => {},
      now: () => 1_900_000_000_000,
    });
    await expect(second.start()).resolves.toEqual({
      status: "signed-in", channel: "stable", subject: "auth0|person",
    });
    const refresh = auth0.requests.filter(({ url }) => url === "/oauth/token").at(-1);
    expect(Object.fromEntries(refresh.body)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rotated-refresh-token",
      client_id: "desktop-client",
    });
    await second.close();
  });

  it("keeps local identity uncertain and disables the generation when refresh is unverifiable", async () => {
    let refreshAttempt = 0;
    const auth0 = await fakeAuth0({ tokenHandler: ({ issuer, privateKey }) => {
      refreshAttempt += 1;
      if (refreshAttempt === 1) return undefined;
      return {
        json: {
          token_type: "Bearer", expires_in: 3600, refresh_token: "bad-rotation",
          id_token: idToken({ privateKey, issuer: `${issuer}wrong/`, clientId: "desktop-client", expiresAt: 2_000_000_000 }),
        },
      };
    } });
    let launchUrl;
    const first = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
    await first.service.start();
    await first.service.login();
    await callbackFromLauncher(launchUrl);
    await first.service.waitForIdle();
    await first.service.close();

    const second = createDesktopAccountService({
      channel: "stable", credentialPath: join(first.directory, "account.json"),
      auth0: { issuer: auth0.issuer, clientId: auth0.clientId },
      launcherUrl: "https://app.relayerlabs.ai/desktop/login",
      encrypt: async (value) => Buffer.from(`sealed:${value}`).toString("base64"),
      decrypt: async (value) => Buffer.from(value, "base64").toString("utf8").slice(7),
      openExternal: async () => {}, now: () => 1_900_000_000_000,
    });
    await expect(second.start()).resolves.toEqual({
      status: "uncertain", channel: "stable", subject: "auth0|person", reason: "unverifiable",
    });
    await second.close();
  });

  it("rejects a mismatched authorized party even with one matching audience", async () => {
    const auth0 = await fakeAuth0({ tokenHandler: ({ issuer, privateKey }) => ({
      json: {
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "must-not-persist",
        id_token: idToken({
          privateKey,
          issuer,
          clientId: "desktop-client",
          azp: "different-public-client",
          expiresAt: 2_000_000_000,
        }),
      },
    }) });
    let launchUrl;
    const { service, directory } = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
    await service.start();
    await service.login();
    await callbackFromLauncher(launchUrl);
    await expect(service.waitForIdle()).resolves.toEqual({
      status: "error", channel: "stable", reason: "authentication-failed",
    });
    await expect(readFile(join(directory, "account.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await service.close();
  });

  it("disables the current generation and clears credentials before remote revocation settles", async () => {
    let releaseRevoke;
    const auth0 = await fakeAuth0({});
    const revokeServer = servers.find((server) => server.listening && server.address().port === Number(new URL(auth0.issuer).port));
    const originalListeners = revokeServer.listeners("request");
    revokeServer.removeAllListeners("request");
    revokeServer.on("request", (request, response) => {
      if (request.url === "/oauth/revoke") {
        new Promise((resolve) => { releaseRevoke = resolve; }).then(() => { response.statusCode = 200; response.end(); });
        return;
      }
      originalListeners[0](request, response);
    });
    let launchUrl;
    const { service, directory } = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
    await service.start();
    await service.login();
    await callbackFromLauncher(launchUrl);
    await service.waitForIdle();
    const logout = service.logout();
    await vi.waitFor(async () => expect(service.account()).resolves.toEqual({ status: "signed-out", channel: "stable" }));
    expect(service.telemetryIdentity()).toBeNull();
    await expect(readFile(join(directory, "account.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await vi.waitFor(() => expect(releaseRevoke).toBeTypeOf("function"));
    releaseRevoke();
    await expect(logout).resolves.toEqual({ status: "signed-out", channel: "stable" });
    await service.close();
  });

  it("passes only the constrained public state through the preserved account IPC", async () => {
    const handlers = new Map();
    const order = [];
    const signedIn = { status: "signed-in", channel: "preview", subject: "auth0|pseudonym" };
    registerDesktopIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { openExternal: vi.fn() },
      nativeTheme: {},
      credentials: {
        account: vi.fn(async () => signedIn),
        login: vi.fn(async () => ({ status: "signing-in", channel: "preview" })),
        logout: vi.fn(async () => ({ status: "signed-out", channel: "preview" })),
        setChannel: vi.fn(async () => { order.push("account"); }),
      },
      modelCatalog: { settingsOpened() {}, explicitRefresh() {} },
      settings: { read: async () => ({}), update: async (update) => { order.push("settings"); return update({}); } },
      tutorial: { read() {}, beginAutomatic() {}, beginManual() {}, dismiss() {}, complete() {} },
      updater: {
        status: () => ({ phase: "idle" }), check() {}, download() {}, install() {},
        setChannel: () => { order.push("updater"); return { channel: "preview" }; },
      },
      getWindow: () => null,
      getAppearance: () => "dark",
      setAppearance() {},
    });
    await expect(handlers.get("relayer:account-read")()).resolves.toEqual(signedIn);
    await expect(handlers.get("relayer:account-login")()).resolves.toEqual({ status: "signing-in", channel: "preview" });
    await expect(handlers.get("relayer:account-logout")()).resolves.toEqual({ status: "signed-out", channel: "preview" });
    await expect(handlers.get("relayer:update-channel")(null, "preview")).resolves.toEqual({ channel: "preview" });
    expect(order).toEqual(["updater", "account", "settings"]);
  });
});

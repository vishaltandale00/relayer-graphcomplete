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

async function fixture({ auth0, channel = "stable", portsByChannel, openExternal, now = () => 1_900_000_000_000, timeoutMs = 2_000, beforeCredentialCommit, telemetry, emit } = {}) {
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
  });
  return { directory, service, encrypted };
}

function reopenedService({ auth0, directory, timeoutMs }) {
  return createDesktopAccountService({
    channel: "stable",
    credentialPath: join(directory, "account.json"),
    auth0: { issuer: auth0.issuer, clientId: auth0.clientId },
    launcherUrl: "https://app.relayerlabs.ai/desktop/login",
    encrypt: async (value) => Buffer.from(`sealed:${value}`).toString("base64"),
    decrypt: async (value) => Buffer.from(value, "base64").toString("utf8").slice(7),
    openExternal: async () => {},
    now: () => 1_900_000_000_000,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
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
  it("binds the callback before launch and serializes login, channel switches, and PKCE exchange", async () => {
    // Phase 1: one valid PKCE exchange proves the callback listener exists
    // before the browser launches and that no secret survives in public state.
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

    await expect(service.start(), "start reports signed-out baseline").resolves.toEqual({ status: "signed-out", channel: "stable" });
    await expect(service.login(), "login reports signing-in").resolves.toEqual({ status: "signing-in", channel: "stable" });
    expect(boundDuringOpen, "callback bound before browser launch").toBe(true);
    const launcher = new URL(launchUrl);
    expect(launcher.origin + launcher.pathname, "launcher URL").toBe("https://app.relayerlabs.ai/desktop/login");
    expect(launcher.searchParams.get("channel"), "launcher channel parameter").toBe("stable");
    expect(new URL(launcher.searchParams.get("redirect_uri")).port, "launcher redirect port").toBe("49152");
    expect(launcher.searchParams.get("state"), "launcher state entropy").toMatch(/^[A-Za-z0-9_-]{43,256}$/);
    expect(launcher.searchParams.get("code_challenge"), "launcher PKCE challenge").toMatch(/^[A-Za-z0-9_-]{43}$/);

    const callback = await callbackFromLauncher(launchUrl);
    expect(callback.status, "valid callback response").toBe(200);
    await expect(service.waitForIdle(), "valid callback settles signed-in").resolves.toEqual({
      status: "signed-in", channel: "stable", subject: "auth0|person",
    });
    expect(service.telemetryIdentity(), "verified generation admitted").toEqual({ generation: 1, subject: "auth0|person" });
    const tokenRequest = auth0.requests.find(({ url }) => url === "/oauth/token");
    expect(Object.fromEntries(tokenRequest.body), "token request fields").toMatchObject({
      grant_type: "authorization_code",
      client_id: "desktop-client",
      code: "authorization-code",
      redirect_uri: "http://127.0.0.1:49152/auth/callback",
    });
    const verifier = tokenRequest.body.get("code_verifier");
    expect(createHash("sha256").update(verifier).digest("base64url"), "PKCE verifier matches challenge")
      .toBe(launcher.searchParams.get("code_challenge"));
    expect(JSON.stringify(await service.account()), "no secrets in account()").not.toMatch(/token|verifier|code|state|issuer|client/i);
    expect(encrypted.at(-1), "encrypted refresh material persisted").toContain("rotated-refresh-token");
    expect(await readFile(join(directory, "account.json"), "utf8"), "credential file hides refresh token").not.toContain("rotated-refresh-token");
    await expect(callbackFromLauncher(launchUrl), "consumed callback is not replayed").rejects.toThrow();
    await service.close();

    // Phase 2: an occupied port falls through only inside the selected channel pool.
    const fallThroughAuth0 = await fakeAuth0();
    const blocker = createServer();
    await listen(blocker, "127.0.0.1", DESKTOP_ACCOUNT_PORTS.preview[0]);
    let previewLaunchUrl;
    const preview = await fixture({
      auth0: fallThroughAuth0,
      channel: "preview",
      openExternal: async (value) => { previewLaunchUrl = value; },
    });
    await preview.service.start();
    await preview.service.login();
    expect(new URL(new URL(previewLaunchUrl).searchParams.get("redirect_uri")).port, "occupied-port fall-through stays in channel pool").toBe("49156");
    expect(previewLaunchUrl, "fall-through never uses another channel pool").not.toContain("49152");
    await preview.service.logout();
    await preview.service.close();
    servers.splice(servers.indexOf(blocker), 1);
    await new Promise((resolve) => blocker.close(resolve));

    // Phase 3: switching the authoritative channel pool preserves a verified account.
    const channelAuth0 = await fakeAuth0();
    let channelLaunchUrl;
    const channel = await fixture({ auth0: channelAuth0, openExternal: async (value) => { channelLaunchUrl = value; } });
    await channel.service.start();
    await expect(channel.service.setChannel("preview"), "channel switch while signed out").resolves.toEqual({ status: "signed-out", channel: "preview" });
    await channel.service.login();
    expect(new URL(new URL(channelLaunchUrl).searchParams.get("redirect_uri")).port, "preview pool redirect port").toBe("49155");
    await callbackFromLauncher(channelLaunchUrl);
    await channel.service.waitForIdle();
    await expect(channel.service.setChannel("stable"), "channel switch preserves verified account").resolves.toEqual({
      status: "signed-in", channel: "stable", subject: "auth0|person",
    });
    expect(channel.service.telemetryIdentity(), "channel switch preserves telemetry identity").toMatchObject({ subject: "auth0|person" });
    await channel.service.login();
    expect(new URL(new URL(channelLaunchUrl).searchParams.get("redirect_uri")).port, "stable pool redirect port after switch back").toBe("49152");
    await channel.service.logout();
    await channel.service.close();

    // Phase 4: overlapping login attempts serialize behind one listener owner.
    const overlapAuth0 = await fakeAuth0();
    const launches = [];
    let enterFirst;
    let releaseFirst;
    const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const overlap = await fixture({
      auth0: overlapAuth0,
      openExternal: async (value) => {
        launches.push(value);
        if (launches.length === 1) {
          enterFirst();
          await firstGate;
        }
      },
    });
    await overlap.service.start();
    const first = overlap.service.login();
    await firstEntered;
    const second = overlap.service.login();
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches, "second login waits behind the first launch").toHaveLength(1);
    releaseFirst();
    await first;
    await second;
    expect(launches, "serialized launches both complete").toHaveLength(2);
    expect(new URL(launches[0]).searchParams.get("state"), "serialized launches keep distinct states")
      .not.toBe(new URL(launches[1]).searchParams.get("state"));
    await callbackFromLauncher(launches[1]);
    await expect(overlap.service.waitForIdle(), "final launch settles signed-in").resolves.toMatchObject({ status: "signed-in" });
    expect(overlapAuth0.requests.filter(({ url }) => url === "/oauth/token"), "one token exchange for serialized logins").toHaveLength(1);
    await overlap.service.close();

    // Phase 5: a channel switch serializes after an in-flight login launch and
    // closes the old listener.
    const switchAuth0 = await fakeAuth0();
    const switchLaunches = [];
    let enterLaunch;
    let releaseLaunch;
    const launchEntered = new Promise((resolve) => { enterLaunch = resolve; });
    const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
    const switcher = await fixture({
      auth0: switchAuth0,
      openExternal: async (value) => {
        switchLaunches.push(value);
        if (switchLaunches.length === 1) {
          enterLaunch();
          await launchGate;
        }
      },
    });
    await switcher.service.start();
    const login = switcher.service.login();
    await launchEntered;
    const switchChannel = switcher.service.setChannel("preview");
    await new Promise((resolve) => setImmediate(resolve));
    await expect(switcher.service.account(), "channel switch waits for the in-flight login").resolves.toEqual({ status: "signing-in", channel: "stable" });
    releaseLaunch();
    await login;
    await expect(switchChannel, "channel switch settles after the launch owner").resolves.toEqual({ status: "signed-out", channel: "preview" });
    await expect(callbackFromLauncher(switchLaunches[0]), "old listener closed on channel switch").rejects.toThrow();
    await switcher.service.login();
    expect(new URL(new URL(switchLaunches[1]).searchParams.get("redirect_uri")).port, "post-switch login uses the preview pool").toBe("49155");
    await switcher.service.logout();
    await switcher.service.close();
  }, 20_000);

  it("rejects the complete callback and token mutation corpus fail-closed", async () => {
    const httpMutationRow = (label, mutation) => [label, async () => {
      const auth0 = await fakeAuth0();
      let launchUrl;
      const { service } = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
      try {
        await service.start();
        await service.login();
        const launcher = new URL(launchUrl);
        const callback = new URL(launcher.searchParams.get("redirect_uri"));
        callback.search = new URLSearchParams({
          code: "authorization-code",
          state: launcher.searchParams.get("state"),
        });
        expect(await rawCallback(callback, mutation(callback)), `${label}: malformed callback response`).toBe(400);
        await expect(service.waitForIdle(), `${label}: attempt fails closed`).resolves.toEqual({
          status: "error", channel: "stable", reason: "authentication-failed",
        });
        await expect(callbackFromLauncher(launchUrl), `${label}: late valid callback rejected`).rejects.toThrow();
        expect(auth0.requests.filter(({ url }) => url === "/oauth/token"), `${label}: no token exchange`).toHaveLength(0);
      } finally {
        await service.close();
      }
    }];

    const cases = [
      ["state mismatch", async () => {
        const auth0 = await fakeAuth0();
        let launchUrl;
        const { service } = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
        try {
          await service.start();
          await service.login();
          expect((await callbackFromLauncher(launchUrl, { state: randomBytes(32).toString("base64url") })).status, "state mismatch: forged-state response").toBe(400);
          await expect(service.waitForIdle(), "state mismatch: attempt fails closed").resolves.toEqual({
            status: "error", channel: "stable", reason: "authentication-failed",
          });
          await expect(callbackFromLauncher(launchUrl), "state mismatch: late valid callback rejected").rejects.toThrow();
          expect(auth0.requests.filter(({ url }) => url === "/oauth/token"), "state mismatch: no token exchange").toHaveLength(0);
        } finally {
          await service.close();
        }
      }],
      httpMutationRow("wrong callback path", (callback) => ({ path: `/other${callback.search}` })),
      httpMutationRow("wrong callback method", () => ({ method: "POST" })),
      httpMutationRow("spoofed host header", () => ({ host: "attacker.example" })),
      ["explicit cancellation", async () => {
        const auth0 = await fakeAuth0();
        let launchUrl;
        const { service } = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
        try {
          await service.start();
          await service.login();
          expect((await cancellationFromLauncher(launchUrl)).status, "cancellation: error callback response").toBe(400);
          await expect(service.waitForIdle(), "cancellation: returns to signed out").resolves.toEqual({ status: "signed-out", channel: "stable" });
          expect(auth0.requests.filter(({ url }) => url === "/oauth/token"), "cancellation: no token exchange").toHaveLength(0);
        } finally {
          await service.close();
        }
      }],
      ["duplicate state parameter", async () => {
        const auth0 = await fakeAuth0();
        let launchUrl;
        const { service } = await fixture({ auth0, openExternal: async (value) => { launchUrl = value; } });
        try {
          await service.start();
          await service.login();
          const launcher = new URL(launchUrl);
          const callback = new URL(launcher.searchParams.get("redirect_uri"));
          const duplicateState = launcher.searchParams.get("state");
          callback.search = `error=access_denied&state=${encodeURIComponent(duplicateState)}&state=${encodeURIComponent(duplicateState)}`;
          expect((await fetch(callback)).status, "duplicate state: ambiguous callback response").toBe(400);
          await expect(service.waitForIdle(), "duplicate state: attempt fails closed").resolves.toEqual({
            status: "error", channel: "stable", reason: "authentication-failed",
          });
          expect(auth0.requests.filter(({ url }) => url === "/oauth/token"), "duplicate state: no token exchange").toHaveLength(0);
        } finally {
          await service.close();
        }
      }],
      ["login timeout without callback", async () => {
        const auth0 = await fakeAuth0();
        const { service } = await fixture({ auth0, timeoutMs: 10 });
        try {
          await service.start();
          await service.login();
          await expect(service.waitForIdle(), "timeout: attempt fails closed").resolves.toEqual({
            status: "error", channel: "stable", reason: "authentication-failed",
          });
          expect(auth0.requests.filter(({ url }) => url === "/oauth/token"), "timeout: no token exchange").toHaveLength(0);
        } finally {
          await service.close();
        }
      }],
      ["mismatched authorized party", async () => {
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
        try {
          await service.start();
          await service.login();
          await callbackFromLauncher(launchUrl);
          await expect(service.waitForIdle(), "mismatched azp: exchange fails closed").resolves.toEqual({
            status: "error", channel: "stable", reason: "authentication-failed",
          });
          await expect(readFile(join(directory, "account.json"), "utf8"), "mismatched azp: no credential commit").rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await service.close();
        }
      }],
    ];
    expect(cases, "rejection corpus inventory").toHaveLength(8);
    const outcomes = [];
    for (const [label, run] of cases) {
      try {
        await run();
        outcomes.push({ status: "fulfilled", value: label });
      } catch (error) {
        outcomes.push({ status: "rejected", reason: new Error(`Case failed: ${label}`, { cause: error }) });
      }
    }
    expect(outcomes, "every rejection corpus row fails closed").toEqual(
      cases.map(([label]) => ({ status: "fulfilled", value: label })),
    );
  }, 20_000);

  it("retires telemetry and credentials before publishing logout and before remote revocation settles", async () => {
    // Phase 1: logout invalidates an in-flight code exchange generation.
    let releaseExchange;
    const exchangeAuth0 = await fakeAuth0({ tokenHandler: async () => {
      await new Promise((resolve) => { releaseExchange = resolve; });
      return undefined;
    } });
    let exchangeLaunchUrl;
    const exchange = await fixture({ auth0: exchangeAuth0, openExternal: async (value) => { exchangeLaunchUrl = value; } });
    await exchange.service.start();
    await exchange.service.login();
    expect((await callbackFromLauncher(exchangeLaunchUrl)).status, "in-flight exchange accepted for processing").toBe(200);
    await vi.waitFor(() => expect(releaseExchange, "token exchange reached the gate").toBeTypeOf("function"));
    await expect(exchange.service.logout(), "logout during in-flight exchange").resolves.toEqual({ status: "signed-out", channel: "stable" });
    releaseExchange();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(exchange.service.account(), "invalidated exchange cannot commit").resolves.toEqual({ status: "signed-out", channel: "stable" });
    await expect(readFile(join(exchange.directory, "account.json"), "utf8"), "invalidated exchange leaves no credential file").rejects.toMatchObject({ code: "ENOENT" });
    await exchange.service.close();

    // Phase 2: logout deletion serializes after an already-started credential commit.
    const commitAuth0 = await fakeAuth0();
    let releaseCommit;
    let enteredCommit;
    const commitEntered = new Promise((resolve) => { enteredCommit = resolve; });
    let commitLaunchUrl;
    const commit = await fixture({
      auth0: commitAuth0,
      openExternal: async (value) => { commitLaunchUrl = value; },
      beforeCredentialCommit: async () => {
        enteredCommit();
        await new Promise((resolve) => { releaseCommit = resolve; });
      },
    });
    await commit.service.start();
    await commit.service.login();
    await callbackFromLauncher(commitLaunchUrl);
    await commitEntered;
    const logoutAfterCommit = commit.service.logout();
    await expect(commit.service.account(), "commit still in flight while logout waits").resolves.toEqual({ status: "signing-in", channel: "stable" });
    releaseCommit();
    await logoutAfterCommit;
    await expect(commit.service.account(), "logout wins after the commit settles").resolves.toEqual({ status: "signed-out", channel: "stable" });
    await expect(readFile(join(commit.directory, "account.json"), "utf8"), "committed credential file deleted by logout").rejects.toMatchObject({ code: "ENOENT" });
    await commit.service.close();

    // Phase 3: telemetry identity retires and credentials clear before the
    // signed-out state is published; each verified generation binds before signed-in.
    const orderAuth0 = await fakeAuth0();
    const order = [];
    let orderLaunchUrl;
    let signedOutCredentialCheck;
    const telemetry = {
      transitionIdentity: vi.fn(async (identity) => { order.push(identity === null ? "telemetry-disabled" : `telemetry-enabled:${identity.generation}`); }),
      retireIdentity: vi.fn(async () => { order.push("telemetry-retired"); }),
    };
    const ordered = await fixture({
      auth0: orderAuth0,
      telemetry,
      openExternal: async (value) => { orderLaunchUrl = value; },
      emit: (state) => {
        order.push(`state:${state.status}`);
        if (state.status === "signed-out") {
          signedOutCredentialCheck = readFile(join(ordered.directory, "account.json"), "utf8")
            .then(() => ({ exists: true }), (error) => ({ error }));
        }
      },
    });

    await ordered.service.start();
    await ordered.service.login();
    await callbackFromLauncher(orderLaunchUrl);
    await ordered.service.waitForIdle();
    expect(order, "verified generation binds telemetry before signed-in").toContain("telemetry-enabled:1");
    expect(order.indexOf("telemetry-enabled:1"), "telemetry binding precedes signed-in publish").toBeLessThan(order.indexOf("state:signed-in"));

    order.length = 0;
    await ordered.service.logout();
    expect(order, "telemetry retired before logout publishes").toEqual(["telemetry-retired", "state:signed-out"]);
    await expect(signedOutCredentialCheck, "credentials cleared before signed-out publish").resolves.toMatchObject({ error: { code: "ENOENT" } });
    await ordered.service.close();

    // Phase 4: the generation disables and credentials clear before remote
    // revocation settles.
    const revokeAuth0 = await fakeAuth0({});
    let releaseRevoke;
    const revokeServer = servers.find((server) => server.listening && server.address().port === Number(new URL(revokeAuth0.issuer).port));
    const originalListeners = revokeServer.listeners("request");
    revokeServer.removeAllListeners("request");
    revokeServer.on("request", (request, response) => {
      if (request.url === "/oauth/revoke") {
        new Promise((resolve) => { releaseRevoke = resolve; }).then(() => { response.statusCode = 200; response.end(); });
        return;
      }
      originalListeners[0](request, response);
    });
    let revokeLaunchUrl;
    const revoking = await fixture({ auth0: revokeAuth0, openExternal: async (value) => { revokeLaunchUrl = value; } });
    await revoking.service.start();
    await revoking.service.login();
    await callbackFromLauncher(revokeLaunchUrl);
    await revoking.service.waitForIdle();
    const logout = revoking.service.logout();
    await vi.waitFor(async () => expect(revoking.service.account(), "local retirement precedes remote revocation").resolves.toEqual({ status: "signed-out", channel: "stable" }));
    expect(revoking.service.telemetryIdentity(), "generation disabled before revocation settles").toBeNull();
    await expect(readFile(join(revoking.directory, "account.json"), "utf8"), "credentials cleared before revocation settles").rejects.toMatchObject({ code: "ENOENT" });
    await vi.waitFor(() => expect(releaseRevoke, "revocation request reached the gate").toBeTypeOf("function"));
    releaseRevoke();
    await expect(logout, "logout resolves once revocation settles").resolves.toEqual({ status: "signed-out", channel: "stable" });
    await revoking.service.close();
  }, 20_000);

  it("restores encrypted refresh material on restart and exposes only constrained account state", async () => {
    // Phase 1: only encrypted rotating refresh material persists, and a fresh
    // process restores signed-in state by direct refresh.
    const refreshAuth0 = await fakeAuth0();
    let refreshLaunchUrl;
    const first = await fixture({ auth0: refreshAuth0, openExternal: async (value) => { refreshLaunchUrl = value; } });
    await first.service.start();
    await first.service.login();
    await callbackFromLauncher(refreshLaunchUrl);
    await first.service.waitForIdle();
    await first.service.close();

    const second = reopenedService({ auth0: refreshAuth0, directory: first.directory });
    await expect(second.start(), "restart restores signed-in by direct refresh").resolves.toEqual({
      status: "signed-in", channel: "stable", subject: "auth0|person",
    });
    const refresh = refreshAuth0.requests.filter(({ url }) => url === "/oauth/token").at(-1);
    expect(Object.fromEntries(refresh.body), "direct refresh grant fields").toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rotated-refresh-token",
      client_id: "desktop-client",
    });
    await second.close();

    // Phase 2: an unverifiable refresh keeps local identity uncertain.
    let refreshAttempt = 0;
    const uncertainAuth0 = await fakeAuth0({ tokenHandler: ({ issuer, privateKey }) => {
      refreshAttempt += 1;
      if (refreshAttempt === 1) return undefined;
      return {
        json: {
          token_type: "Bearer", expires_in: 3600, refresh_token: "bad-rotation",
          id_token: idToken({ privateKey, issuer: `${issuer}wrong/`, clientId: "desktop-client", expiresAt: 2_000_000_000 }),
        },
      };
    } });
    let uncertainLaunchUrl;
    const uncertainFirst = await fixture({ auth0: uncertainAuth0, openExternal: async (value) => { uncertainLaunchUrl = value; } });
    await uncertainFirst.service.start();
    await uncertainFirst.service.login();
    await callbackFromLauncher(uncertainLaunchUrl);
    await uncertainFirst.service.waitForIdle();
    await uncertainFirst.service.close();

    const uncertainSecond = reopenedService({ auth0: uncertainAuth0, directory: uncertainFirst.directory });
    await expect(uncertainSecond.start(), "unverifiable refresh keeps identity uncertain").resolves.toEqual({
      status: "uncertain", channel: "stable", subject: "auth0|person", reason: "unverifiable",
    });
    await uncertainSecond.close();

    // Phase 3: the preserved account IPC surface exposes only constrained
    // public state and the pinned channel-switch order.
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
    await expect(handlers.get("relayer:account-read")(), "IPC account-read exposes public state only").resolves.toEqual(signedIn);
    await expect(handlers.get("relayer:account-login")(), "IPC account-login passthrough").resolves.toEqual({ status: "signing-in", channel: "preview" });
    await expect(handlers.get("relayer:account-logout")(), "IPC account-logout passthrough").resolves.toEqual({ status: "signed-out", channel: "preview" });
    await expect(handlers.get("relayer:update-channel")(null, "preview"), "IPC update-channel passthrough").resolves.toEqual({ channel: "preview" });
    expect(order, "channel switch order: updater, account, settings").toEqual(["updater", "account", "settings"]);
  }, 20_000);
});

# ADR 0008: Direct Auth0 optional desktop account

Status: accepted

## Context

GraphComplete Desktop needs an optional account identity so later privacy-filtered
error reports can be correlated to one pseudonymous user. The desktop is the
primary product and must remain useful while signed out, offline, cancelled, or
unable to refresh. Routing desktop login through a Relayer authentication API
would introduce a session broker, database, and deployment dependency that are not
needed for a public Native Application client.

The existing `app.relayerlabs.ai/login` page remains the ordinary web login. A
separate branded launcher at `app.relayerlabs.ai/desktop/login` is already deployed
for the native flow.

## Decision

Relayer Desktop authenticates directly with the Auth0 GraphComplete Native
Application using Authorization Code + PKCE. The launcher is presentation and
parameter validation only; Auth0 remains the identity and token authority. No
Relayer API, custom desktop session, database record, or Relayer user UUID is part
of this boundary.

Electron main is the sole protocol authority. For each login generation it:

1. selects the callback pool from the saved Stable or Preview update channel;
2. binds `127.0.0.1` before opening the browser, trying only the three registered
   ports for that channel;
3. creates fresh base64url state and an S256 PKCE verifier/challenge;
4. opens the HTTPS Relayer launcher with the exact channel, redirect URI, state,
   and challenge;
5. accepts one exact `/auth/callback` response with matching origin, port, path,
   state, and query shape;
6. exchanges the code directly at Auth0 and verifies the ID token's RS256
   signature, issuer, public-client audience/authorized party, expiry, subject,
   and nonce whenever one was requested;
7. encrypts only the rotating refresh token and pseudonymous Auth0 subject through
   Electron `safeStorage`; and
8. exposes only the current verified generation for telemetry admission.

Stable may bind only ports 49152-49154. Preview may bind only ports 49155-49157.
Changing the saved update channel invalidates an in-flight login and changes the
next callback pool and diagnostics; it does not create a second application
identity or discard a valid account credential.

The renderer receives a closed presentation contract:

- `{status: "signed-out", channel}`
- `{status: "signing-in", channel}`
- `{status: "signed-in", channel, subject}`
- `{status: "uncertain", channel, subject, reason}`
- `{status: "error", channel, reason}`

The renderer never receives authorization codes, state, the verifier, access/ID/
refresh tokens, Auth0 configuration, email/profile data, the account generation,
or direct account network authority. The allowed reason codes are diagnostic-safe
and contain no raw exception text.

On restart, main refreshes directly with Auth0. A verified rotation restores
`signed-in`; offline or unverifiable refresh preserves the pseudonymous local
identity as `uncertain` but yields no telemetry identity. An invalid grant clears
the credential and becomes `signed-out`. Logout first invalidates the generation,
stops the listener, and durably removes encrypted credentials after earlier writes
settle; remote revocation is best effort and cannot re-enable the generation.

After agent-provider setup, optional account sign-in is its own full onboarding
step before the desktop workspace is revealed. The step is visually independent
of projects, chats, and threads and offers both `Sign in` and an explicit
`Continue without an account` action. Continuing without an account durably
suppresses later automatic prompts; account or network failure never traps the
user on this optional step.

After onboarding, a quiet account control is anchored to the bottom-right of the
application viewport rather than participating in sidebar layout. Its ordinary
label never includes Stable or Preview. While signed out, clicking `Sign in`
starts the browser flow directly; an existing or uncertain account opens Account
settings instead. That panel contains only concise account status and the
applicable sign-in or logout action. Release channel is not part of account UX;
main-owned diagnostics retain callback selection. No account state gates
projects, threads, interactions, providers, models, harnesses, permissions,
updates, or exports after the user resolves the onboarding choice.

Default tests use local fake Auth0 and loopback servers. They do not contact the
production tenant.

## Consequences

- Desktop authentication has no Database URL or Relayer backend deployment
  dependency.
- Auth0 and the operating-system credential store are external availability
  dependencies only for optional account verification; local work is not one.
- The Auth0 subject is intentionally pseudonymous and is not a product profile.
- Authenticated error reporting consumes only the main-owned verified generation
  and never reinterprets renderer presentation state as authority. See
  [ADR 0009](0009-authenticated-desktop-error-reporting.md).
- Browser logout is deliberately out of scope; logging out of Desktop revokes and
  clears only Desktop's local grant.

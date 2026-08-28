# ADR 0009: Authenticated desktop error reporting

Status: accepted

## Context

GraphComplete Desktop needs privacy-filtered failure reporting across its renderer,
Electron main, Node harness host, Rust app server, and Rust graph server. Local use
must remain complete while signed out or unverifiable. Reporting must not add a
Relayer API or place Sentry authority in child processes.

The direct Auth0 account boundary in ADR 0008 exposes one verified account
generation to Electron main. The desktop release contract in ADR 0002 supplies
immutable package and candidate identity. Neither boundary defines event admission,
privacy filtering, queueing, process capabilities, or symbol proof.

## Decision

### Authority and admission

Electron main is the sole Sentry authority. It owns SDK and transport configuration,
admission, identity derivation, final event validation, the retry queue, and outbound
requests. Renderer and child processes submit closed local records through
generation-bound capabilities. They never receive tokens, refresh credentials, a
DSN, upload credentials, or independent Sentry transport.

Each capability is bound to the current verified account generation and the source
process generation. An account transition or child restart invalidates it. Signed-
out, uncertain, expired, revoked, stale, or replaced generations produce no request
and no deferred record.

Electron main derives the Sentry user identifier as:

```text
SHA-256("graphcomplete-sentry-user-v1\0" || UTF-8(Auth0 sub))
```

The domain separator prevents reuse as another product identity. The identifier is
stable across installations for the same Auth0 subject. Callers cannot supply or
override identity.

### V1 event contract

V1 reports only:

- unhandled renderer, Electron-main, or Node process crashes;
- supervised-child startup failures; and
- supervised-child unexpected exits.

Handled operation failures are not reported in V1. Validation feedback, permission
denial, user cancellation, handled retry, provider disconnection, authentication
state, warnings, informational events, and success are also excluded.

The accepted record contains only stable failure code or sanitized class, a
code-owned message, approved frames, fixed component and operation identifiers,
sealed release identity, main-owned environment, OS, architecture, and the derived
pseudonym. The final structured event is revalidated immediately before transport.

JavaScript frames use application-relative module names. One event retains at most
32 frames and 256 characters per module name. Rust frames name only approved
workspace crates and modules. Absolute paths and third-party frames are rejected.

Prompts, graph or model content, workspace data, paths, filenames, commands,
environment data, credentials, request data, headers, cookies, URLs, logs, raw
stdout or stderr, arbitrary debug output, arbitrary maps, and raw errors are
forbidden. Default PII, automatic request context, breadcrumbs, attachments, replay,
tracing, profiling, performance events, and console or log capture remain disabled.

### Queue lifecycle

Authenticated transport failure may enter one `safeStorage`-encrypted queue. The
queue has all of these limits:

- at most 32 records;
- at most 256 KiB of encrypted bytes; and
- at most seven days of retention per record.

Overflow evicts the oldest record. Expired records are deleted before flush. Any
corrupt queue is deleted in full. Retry requires fresh validation of the same Auth0
subject. A different account cannot inspect or flush prior records.

Logout or account replacement first invalidates admission and reporting
capabilities. Electron main then deletes the prior queue before publishing the new
account presentation state. Telemetry rejection, queue failure, and transport
failure never create recursive telemetry or change product behavior.

### Release identity and proof

Runtime events obtain immutable candidate and release identity only from sealed
package metadata. Electron main validates the current update channel and supplies
`development`, `preview`, or `stable` as the Sentry environment. Event callers
cannot supply either value.

Renderer, Electron, and Node source maps plus Rust symbols are produced and uploaded
only through release authority. Upload credentials never enter application bytes.
Runtime event transport and symbol upload remain separate authorities.

A versioned shared privacy corpus defines accepted and forbidden fixtures across
all process seams and both repositories. `npm run evidence:telemetry` runs the
deterministic zero-inference portfolio with local Auth0 and capture fakes. It covers
admission, capabilities, privacy, queueing, restart, logout, replacement, release
identity, and recursion suppression.

Live Auth0, real system-browser callbacks, packaged protected storage, artifact
upload, and symbolication proof run only for Preview or Stable release candidates.
Each candidate proves only its native target: macOS Apple Silicon, macOS Intel, or
Windows x64. Missing target evidence remains indeterminate. Another platform or an
unsigned development package cannot satisfy it.

## Consequences

- Local use and graph completion remain independent of account and reporting state.
- Electron main becomes the single privacy and network choke point.
- Cross-process adapters remain small and cannot bypass identity or final filtering.
- The bounded queue has deterministic retention, overflow, corruption, and account-
  replacement behavior.
- V1 deliberately excludes handled terminal operation failures until a later product
  decision names them.
- Default verification remains deterministic, local, and free of paid inference.
- Packaged and symbolication claims are release-candidate and target-specific.

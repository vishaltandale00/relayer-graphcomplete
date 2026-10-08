# ADR 0009: Authenticated desktop error reporting

Status: accepted; handled fatal desktop startup extension approved; share-service network scope and planned oversize-failure exception amended by [ADR 0011](0011-shared-thread-snapshot-service.md)

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

ADR 0011 names one narrow exception for shared-thread publication. Export,
oversize, upload, service, and unexpected deletion failures show a generic error
and attempt reference and may report through Electron main. Cancellation,
sign-in requirements, and quota limits remain excluded. Existing account and
privacy boundaries remain in force. See
[ADR 0011](0011-shared-thread-snapshot-service.md#share-title-and-snapshot-boundary).

The handled-share record admits only a code-owned failure code and stage, the
`SHR-` attempt reference shown to the user, optional snapshot bytes for the
oversize code, the bounded diagnostics described below, and the existing main-owned release, environment, platform, and
pseudonymous account fields. Electron main deduplicates one process lifetime by
account, reference, stage, and code before the ordinary final validator, bounded
queue, and transport. The persisted Electron-main attempt owner records the
same reference/stage/code key before reporting, so retry and process recovery do
not readmit the same handled failure. If that key cannot be persisted, reporting
is suppressed rather than admitting an event that restart could duplicate. Titles, project names, conversation content,
credentials, raw errors, and request data remain forbidden.

The approved share-diagnostics extension retains the first available approved app
stack from the original exception or its causes, bounded to four inspected error
objects and the existing 32-frame inventory limit. It additionally admits an
optional integer HTTP status (100–599) and a network code from the fixed allowlist
in `desktop/main/services/share-error-diagnostics.mjs`; unknown codes are omitted.
TimeoutError maps to the code-owned `TIMEOUT` value. No raw error, cause message,
host, URL, request/response body, header, or frame local is admitted. Diagnostic
inspection cannot alter the product result. Sentry frames use oldest-to-newest
order. Legacy records with no diagnostics remain accepted. Encrypted queue
entries still require the existing same-account, release, and platform checks;
this does not introduce cross-release replay. Deduplication still uses account/reference/stage/code, and the
share attempt store never persists diagnostic stacks or raw exceptions.

### Narrow handled fatal startup exception

`electron_main.startup_failure` is the second closed handled-error exception.
Only Electron main can issue its generation-bound reporter. It admits a code-owned
fatal message, a closed startup stage (`initialization`, `runtime-start`,
`product-server-start`, or `window-load`), a null or allowlisted network code,
and approved application frames. The allowlist lives in
`desktop/main/services/startup-error-diagnostics.mjs`. Main retains release,
environment, platform, architecture, and pseudonymous identity ownership.
Raw URLs, messages, logs, tokens, user paths, and all other fields remain forbidden.
Sentry receives a fatal event with frames in oldest-to-newest order.

One 2.5-second startup budget covers only the existing saved-login verification,
child/runtime attribution, and delivery attempt. Main admits only the verified
saved identity still current after those waits. Signed-out, uncertain, unavailable,
cancelled, revoked, or timed-out identity leaves no request and no deferred record.
A late verification cannot start reporting after that budget. Reporting ends before
native recovery sign-in; the original prelogin failure is never uploaded after login.
An admitted child/runtime event suppresses the corresponding main failure, including
cleanup wrappers. Main deduplicates one startup event per verified generation for
the process lifetime. Authenticated offline delivery uses the existing encrypted
queue and same-account revalidation. Revocation is checked again during persistence.

Native recovery does not require the failed product renderer or reporting authority.
It offers Retry, Sign in and retry when the account service exists, and Quit.
Retry shuts down services and relaunches a clean process. Login returning after
browser launch is insufficient: main waits for `waitForIdle()` and a current
verified signed-in identity before restart. A native waiting dialog permits Cancel
sign-in or Quit; a two-minute deadline, cancellation, failed verification, or
revocation retires the callback and cannot trigger a late relaunch. Cancellation
also removes any credential committed by that exact unfinished attempt, so retry
cannot restore a cancelled callback. Browser callbacks present the active native
recovery window even when there is no product window. Recovery never
reinitializes the failed services in the same process. Shutdown receives ten seconds
before process exit. On macOS a renderer-free native BaseWindow parents the dialogs
so they stay asynchronous and cancellable. Actual packaged platform behavior remains
a release-candidate gate, including Windows x64.

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
- V1 excludes handled terminal operation failures except the exact shared-thread
  publication, unexpected-deletion, and handled fatal startup codes named above.
- Default verification remains deterministic, local, and free of paid inference.
- Packaged and symbolication claims are release-candidate and target-specific.

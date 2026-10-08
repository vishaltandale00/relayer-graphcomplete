# Desktop startup reporting and native recovery

The approved patch extends ADR 0009 with the closed handled fatal
`electron_main.startup_failure` event and renderer-independent recovery.
The affected Windows Preview 0.2.0 machine's root cause remains unconfirmed.
The immutable source/release c2905c193c98529bfcda8891f8a0ada8e2dbc213 is untouched.

## Changed seams and checkpoints

| Production seam | Promise / failure boundary | Deterministic checkpoint |
| --- | --- | --- |
| Main startup catch and window factory | Native recovery after load failure; unusable window/reporter disposed | `desktop-startup-failure-recovery` window/load and choices, including successful loadURL after a fatal child exit; `desktop-shell` startup composition |
| Saved account verification to main reporter | One bounded wait; no unsigned, uncertain, late, revoked, or post-login replay | `desktop-startup-failure-recovery` saved identity, deadlines, revocation, suppression |
| Runtime/app-server adapters and error wrappers | One admitted child failure suppresses corresponding main event | `desktop-error-domain-adapters` and `desktop-startup-failure-recovery` child attribution |
| Main startup reporter / receiver / transport | Main-only generation authority, closed diagnostics, fatal envelope, duplicate suppression | Gateway, receiver, transport and `startup-error-diagnostics` fixtures; versioned privacy corpus |
| Existing encrypted queue | Offline admission, same-account reopen, revocation while sending/encrypting, no unverified record | Gateway encrypted reopen/revocation tests and recovery offline fixture |
| Native choices to account callback | Browser launch is not login completion; cancellation, timeout, late callback cannot restart | Recovery choices and `desktop-account-session` real local Auth0/PKCE/signed token/listener fixtures, including cancel/timeout after credential commit and reopen |
| Shutdown to relaunch/exit | Clean process restart, bounded shutdown, no in-process service reinit | Recovery ordered shutdown/relaunch/exit and shutdown deadline fixtures |
| Share-preview source-bound evidence | Main startup and module-inventory edits invalidate the existing capture receipt | Declared `npm run evidence:share-preview` real Electron synthetic capture and `desktop-social-preview-evidence` receipt validation |
| Module inventory / evidence runner / CI mapping | Exact application modules, versioned portfolio includes new checkpoints | `desktop-telemetry-module-inventory`, `telemetry-evidence`, `ci-affected-plan` |

No tests were deleted or retired. These fixtures protect distinct authority,
privacy, persistence, attribution, and native-account lifecycle boundaries.

## Required verification

Warm loop: targeted Vitest files listed above. Heavy local gates: `npm run check`,
`npm run build`, and `npm run evidence:telemetry` (zero inference, local sinks).
The source-bound share-preview receipt also requires the declared real Electron
`npm run evidence:share-preview` capture; its PNGs and receipt must be regenerated,
never mechanically rehashed.
The repository native cache verifier rejected the discovered local Ladybug bundle
because its Cargo.lock digest differs. No compatible sealed macOS runtime bundle
was available; source compilation is the fallback. Dependencies installed from
locked offline npm cache under Node 22.23.2. The first full-debug check passed
Clippy and default Rust tests, then exhausted disk while compiling crash-feature
artifacts. Its log is preserved. Current-source native outputs were sealed and
hash-verified with the repository's canonical artifact workflow before task-owned
target cleanup. The capacity-safe profile uses `CARGO_PROFILE_DEV_DEBUG=0`,
`CARGO_PROFILE_TEST_DEBUG=0`, and `CARGO_INCREMENTAL=0`. A broad Vitest run then
exposed the stale preview receipt and an unmodified recursive transport fixture's
SQLite lock race. Final portfolio verification limits fresh Vitest workers to two
under the host's concurrent build load. Earlier failures remain visible in local
logs; none substitutes for a passing scenario.

## Results and limits

Exact local command results, source digests, and adversarial assertions are recorded
in `.relayer/evidence/startup-reporting/verification.json` and `reviews.json`. Full
logs and generated local receipts are retained beside them. Local checks do not
establish packaged Windows qualification, actual system-browser/native-dialog UX,
protected storage, live Sentry delivery, or symbolication. Those remain target-specific
Preview/Stable release-context proof. No publish, release, tag, push, or merge is
part of this change. Adversarial review without a PR is non-certifying.

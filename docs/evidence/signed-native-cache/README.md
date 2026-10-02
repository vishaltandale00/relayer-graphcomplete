# Signed native build cache verification

This change accelerates future macOS arm64 Preview compilation. It does not
certify a candidate, cache checks, or change publication authority. PRD release
contract (section 5), TEL-010 and ADRs 0002/0009/0010 remain authoritative.
The user explicitly requested a separate signed-profile artifact contract.

## Planned checkpoints and changed seams

- Native input identity: reuse reviewed packaging inputs plus signed build,
  telemetry, workflow, profile debug=1, default features and symbol-tool identity.
  Deterministic signed-native-cache fixtures exercise invalidation and overrides.
- Artifact discovery/download: accept only API-authenticated repository/main/manual
  signed workflow provenance, successful producing attempt, immutable artifact ID
  and archive SHA-256. Reject untrusted, expired, corrupt or malformed archives.
- Native payload: exact two unsigned servers and complete matching dSYMs;
  inventories, modes, hashes, UUIDs, architecture and DWARF verification precede
  installation. Fixtures use the production verifier, with native tools stubbed.
- buildReleaseRustServers: verified hit skips native/Cargo compilation, retains
  licensing; rejected/missing entries compile locked/offline with debug=1 once.
  Compiler failures propagate; optional cache failures cannot retry compilation.
- Telemetry: copy verified dSYMs without needing original Cargo objects; recheck
  against freshly packaged binaries, regenerate current release/source maps.
- Evidence collector: include the cache suite in the named telemetry portfolio
  and record cache implementation hashes; collector tests inspect the mapping.
- Workflow: upload only native build output, preserve exact-source main CI,
  signing/notarization and immutable candidate/publication gates.

Warm loop: signed cache, packaging cache, Ladybug lifecycle and telemetry artifact
Vitest suites. Required broad gates: npm run check and npm run build. Applicable
heavy entry: npm run evidence:telemetry. No tests retired. Signed-run cold/hit
comparison, actual dSYM upload/symbolication and notarized candidate inspection
remain a separately authorized future Preview gate. No signed workflow dispatch,
push, publication, live Sentry event or paid inference is authorized here.

## Executed evidence

Base: `f80766648b4ff06b64584c042a7afcd5ccb410f3`, fetched from `origin/main`.
Local branch: `codex/signed-native-cache` in the dedicated managed worktree.
Node: 22.23.2. Rust: 1.98.0. No signed workflow or release action was executed.

Original cache executable/workflow/test source digest (superseded by pagination below):
`7b9b7fa3c99b41e744cbb404b698fab4086651832e11630f9a289edbfaaf29d1`.
Algorithm: sort the eight paths listed below; hash each UTF-8 path, one NUL, and
its raw 32-byte file SHA-256 into one SHA-256 stream.

```
.github/workflows/desktop-signed-preview.yml
desktop/packaging/signed-native-cache.mjs
desktop/packaging/signed-native-transport.mjs
desktop/release/build-release.mjs
desktop/release/telemetry-artifacts.mjs
scripts/run-telemetry-evidence.mjs
test/signed-native-cache.test.mjs
test/telemetry-evidence.test.mjs
```

### Passed

- Focused warm suite: 55 tests across five files passed. The new signed-cache
  suite has nine cases; it also passed within the final full and telemetry suites.
- `npm run build`: passed, including Rust servers and all TypeScript workspaces.
- Full JavaScript portfolio inside `npm run check`: 206 files passed, one skipped;
  2,688 tests passed, three skipped. Formatting, Clippy, normal Rust tests and
  crash-reconciliation tests also passed in that invocation.
- Remaining check stages run explicitly after the blocked native probe:
  Python 47/47, Ladybug receipts/probe lint and PRD readability passed.
- `npm run evidence:telemetry`: passed. The actual named portfolio ran five
  shared Rust panic-capability cases and 115 tests across 14 JavaScript files.
  The loopback artifact records local privacy proof and keeps release symbol
  upload/symbolication as `not-run`.
- Real macOS arm64 C fixture: production seal, reopen/verify and install routines
  passed with actual `dsymutil` and `dwarfdump`, including compilation units,
  UUID/architecture, DWARF, relocation inventory and destination hashes. This is
  neither a Rust-server build nor signed candidate proof.
- `git diff --check`: passed.

Before compiling Rust, the repository Ladybug artifact verifier accepted the
existing `/tmp/relayer-0816-lbug` bundle for this checkout, darwin-arm64 and
Rust 1.98.0, including source/lock identity and inventory hashes. Local checks
used its exported library/include paths. It was not used as signed-profile
output. No cache verification failure was suppressed to obtain a native hit.

### Initial failures (preserved)

At the initial PR commit, `npm run check` was **not green**. Its final attempt reached the unchanged
`packages/harness-host/test/codex-secret-provider-process.test.ts:138` probe,
which reported `OPENAI_API_KEY_PRESENT` and `OPENAI_BASE_URL_PRESENT` instead of
absence in its model-requested shell. These are synthetic test credentials.
One additional isolated `npm run test:codex-secret-boundary` run reproduced the
failure (one failed, one passed). An earlier invocation passed both cases.
No provider/runtime source or this test was changed in that initial commit.
The merge-readiness follow-up below records the subsequent diagnosis and fix.

Earlier attempts are retained separately: the first full check encountered an
Electron first-download race and a test loaded against an earlier in-flight
implementation. Electron 43.0.0 was then installed and verified before rerunning.
The next check passed the runtime/test stages but rejected a new PRD sentence;
its wording was fixed and readability passed. The real symbol probe initially
rejected Xcode's relocation YAML files; the exact generated paths were added to
the inventory and the probe passed. None of these earlier attempts is claimed
as a passing final-source gate.

Local raw logs and machine receipts are retained under
`.relayer/evidence/signed-native-cache/`; the telemetry receipt is
`.relayer/evidence/telemetry-v1.json`. These ignored local artifacts accompany
this checkout; the assertions above are the durable checked-in summary.

### Adversarial review assertions

- Reviewer `cache_contract_review`: exact eight-file digest above; native input
  identity, API producer trust, archive handling, consumer hashes, symbols,
  fallback, workflow and collector seams; no unresolved actionable findings.
- Reviewer `verification_review`: same exact digest; checkpoint mapping, real
  production seams, independent invalidation fixtures and workflow operability;
  no unresolved actionable findings. Reviewer ran the nine cache cases and two
  evidence-collector cases successfully.

These assertions are recorded in PR #552. Their source assertions apply
only to the recorded executable digest; changing that scope invalidates them.
They do not certify a signed candidate.

### Merge-readiness follow-up

The full local check reproduced the native secret-boundary failure after all
2,688 ordinary JavaScript tests passed. Eleven isolated probe invocations had
passed earlier; those passes did not establish that the failure was fixed.
A diagnostic loopback fixture waited for Codex 0.147's actual shell snapshot
before returning its shell request. It deterministically exposed synthetic
provider variables: snapshots capture the app-server environment and source it
after shell-policy filtering. Disabling snapshots removed that path.

Additional changed seams and checkpoints:

- Secret-backed Codex execution now enforces `features.shell_snapshot=false`.
  PRD AGT-007 already excludes credentials from persistence and diagnostics.
  The warm harness test checks the production override. The native probe checks
  that the pinned binary parses the exact production overrides with snapshots
  disabled even when the fixture enables them, then exercises actual endpoint
  authentication and shell-variable exclusion. The regression failed against
  the old source and passed after the fix. The separate fresh-child graph
  capability scenario still runs. Managed subscription access is unchanged.
- CI run `36422173151` stopped producing test output after about two minutes and
  was cancelled after about 18 minutes. The only unfinished isolated file was
  `ci-merge-freshness.test.mjs`; cleanup found its orphaned `unzip` process.
  The decoder now uses SIGKILL when its existing time/output bounds are exceeded.
  A TERM-handling pipe stall is the inferred cause, not a confirmed Linux replay.
  The real ZIP checkpoint now supplies a 1 MiB compressible member under the
  archive size bound and runs the production decoder in a child with a seven
  second process-group deadline. It requires a bounded-output/time rejection.
  No freshness acceptance rule or required check was weakened.

Focused results: 46 harness cases, two native boundary cases, and 34 freshness
cases passed. No tests were removed. The full `npm run check` and `npm run build`
then passed on the recorded cache and follow-up source digests: 2,688 ordinary
JavaScript tests, two native boundary cases, 47 Python cases, Rust suites,
receipt checks, and readability. Hosted CI for the follow-up commit remains a
separate required gate recorded in the PR.

Follow-up adversarial reviewer `verification_review` accepted five-file digest
`952766d573b9bb939d330a5a5a76ff8d6c88edd7ab4ce96c3baf269b97efd438`
above base `eebe67e00547c483441efb29909646e59b08fbbe`, with no unresolved
actionable findings. Scope: secret snapshot prevention, native authentication
and shell authority, bounded ZIP termination. The reviewer independently ran
80 adapter/freshness cases and two native process cases successfully. This
digest uses the algorithm above over these paths:

```
packages/harness-host/src/implementations/codex-basic.ts
packages/harness-host/test/codex-basic.test.ts
packages/harness-host/test/codex-secret-provider-process.test.ts
scripts/ci/merge-freshness.mjs
test/ci-merge-freshness.test.mjs
```

### GitHub review follow-up: artifact pagination

The hosted review identified a compatible-artifact discovery gap after 100 newer
unrelated repository artifacts. Discovery now reads at most five pages of 100
artifacts and keeps at most five matching candidates. Every candidate still
passes the same API provenance, archive digest, inventory and consumer checks.
Older entries beyond this bounded search remain a fresh-build miss. The restore
journey now verifies a real fixture on page two after 100 unrelated artifacts;
the same scenario verifies that an exhausted search stops after five pages.

Reviewer `cache_contract_review` reviewed the updated eight-file scope above:
`e3f6365fe8c5757af712dc535fe1f729d07e0dabf46599090c2ecbe96dd8d49c`.
Verdict: no unresolved actionable findings. The reviewer independently passed
the nine cache cases and two collector cases with Node 22.23.2. Earlier cache
review assertions remain historical; this assertion covers pagination.

CI run `36425263607` passed on the preceding head, including 2,698 Linux
JavaScript tests and the 34 freshness cases. GitHub nevertheless showed the
required freshness result as Expected: repeated guard runs on the same head
attached custom checks to an older check suite. One original-run retry did not
clear that discrepancy. The pagination follow-up supplies a new head and fresh
CI; no required status, protection, or freshness acceptance rule was relaxed.

Final local pagination validation: `npm run check` passed its Rust stages, then
failed one unchanged graph-search parity case at line 76 with a query wall-time
budget error (2,687 ordinary JavaScript cases passed, one failed, three skipped).
An isolated run of that case passed in 6.84 seconds. Contention is plausible,
not established; the failed broad run remains a failure. No budget was changed.
The stages skipped by that failure ran explicitly and passed: two native Codex
cases, 47 Python cases, receipt lint and PRD readability. `npm run build` and
`npm run evidence:telemetry` also passed; the latter reran five Rust cases and
115 JavaScript cases against the updated cache scope. Fresh final-head hosted
CI must include the parity case and full selected portfolio before handoff.

### Remaining authorized release-context proof

After the repository gate is resolved and changes are reviewed/approved, obtain
separate authorization for cold and compatible-hit signed Preview runs. Verify
actual hosted artifact restore, native-stage avoidance, archive ID/digest and
producer attempt, both Rust binaries and symbols, fresh signing/notarization,
telemetry upload/correlation, and candidate receipts. No hosted hit, Sentry
symbolication, candidate acceptance or publication is claimed here. The existing
Preview run and its source/worktree/tags were not modified.

## 2026-09-30 symbol producer repair

The repeated cache-sealing failure and post-Cargo symbol repair are tracked in
[the repair checkpoint and evidence ledger](repair-2026-09-30.md). Historical
passes above do not certify this changed implementation or hosted seeding.

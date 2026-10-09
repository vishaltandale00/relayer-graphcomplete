# Windows managed Codex installation promotion

Base: `677035322f33ee61327f0737d50b4db8e91e8ae9`.
Worktree: `relayer-graphcomplete-windows-codex-install-rename`.
Branch: `codex/windows-codex-install-rename`.

## Finding and correction

The affected user's Connect failed with `EPERM` renaming the verified staging
`installation` directory into `codex/windows-x64/installations/<uuid>`.
Both preparation and app-update staging used a single rename.
The user's Windows locking actor is **unconfirmed**; there is no evidence here
attributing it to antivirus, ACLs, or an owned probe process.

The deterministic reproduction injects that exact filesystem error at the real
promotion seam after artifact verification, readiness and ownership recording.
A second fixture demonstrates that the old Codex probe returns after `exit`
before `close`, permitting promotion while simulated Windows resources remain
held. Node distinguishes process exit from process-and-stdio closure:
[ChildProcess close](https://nodejs.org/api/child_process.html#event-close).
Neither fixture reproduces Windows kernel locking on this macOS host.

The correction waits for `close` observed from child creation, including version
probes shared by Codex and Claude. EOF remains Codex's graceful shutdown. If
closure does not arrive, bounded SIGTERM then SIGKILL waits follow; an unconfirmed
close rejects readiness. Handshake abort/timeout now removes its listeners.
Only immutable installation promotion retries Windows `EPERM`, `EACCES`, or
`EBUSY`: seven attempts, at most 1.75 seconds of backoff, abortable between
attempts. The verified source and generated destination stay identical. There
is no copy fallback or permission repair. Active and pending pointer writes do
not acquire retries. App-update staging checks cancellation before committing
its pending receipt, including cancellation during a successful rename.

## Changed seams and checkpoint mapping

| Changed executable seam | Product checkpoint | Smallest deterministic observation |
| --- | --- | --- |
| `install` and `stageOne` staging directory promotion | MRT-375-3 transactional activation and repair | `managed-runtime-promotion.test.mjs`: transient denial for each retryable code in both paths; exact validated bytes after preparation/update activation |
| Promotion retry failure and cancellation | MRT-375-3; MRT-375-4 contained lifecycle cleanup | Persistent EPERM preserves prior active/pending receipts, executable generation and private session data; backoff cancellation and cancellation during successful rename drain owned staging/generation without a new pointer |
| Retry authority boundary | MRT-375-3; MRT-375-4 | ENOSPC/EXDEV/EEXIST and macOS EPERM attempt only one rename; no broader filesystem fallback |
| `executableVersion` shared Codex/Claude closure | MRT-375-3 readiness before activation | Version output arriving after exit remains observable through close; existing Claude SDK export and hung version tests still pass |
| `codexInitialize` handshake and terminal cleanup | MRT-375-3; MRT-375-4 | Actual preparation waits for delayed close; forced shutdown can complete; never-close and abort reject before any rename |
| `stageOne` pre-pending cancellation check | MRT-375-3 | Cancellation during successful update promotion removes that moved generation and does not commit pending state |

No product policy or PRD meaning changes. Existing installer tests remain for
artifact integrity, recipe identity, deduplication, ownership, symlink/traversal
confinement, activation and rollback. The new file protects promotion denial and
owned-probe lifecycle boundaries they did not observe. No tests were deleted;
existing process doubles now emit `close` as real ChildProcess does.

## Required verification plan

- Warm loop: the promotion regression file and existing installer suite.
- Handoff: installer, promotion, provider integration, updater, resolver and
  Windows app-runtime suites, after building workspace packages.
- Repository gates: `npm run check` and `npm run build`, with the prerequisite
  doctor and trusted artifact inspection before native compilation.
- No paid inference, signing, publication or release checks are part of this fix.
- Packaged Windows reproduction remains separate and unavailable on this host.

## Executed evidence

- [Red loop](regression-before.txt): three failures against the old behavior
  with only the injectable rename seam added. Both paths show the EPERM symptom;
  the close-order test observes an early promotion.
- [Affected suites](focused-tests.txt): six files, 123 tests passed on macOS
  arm64 with Node 22.22.3. This includes 21 new regression scenarios.
- Developer prerequisite doctor: passed. Workspace package build: passed.
- An initial affected-suite invocation was incomplete: provider integration
  lacked built `@relayer/graph-client`, and the macOS fixture's changed target
  had a stale recipe digest. The package build and corrected fixture produced
  the passing invocation above; neither initial result was counted as a pass.
- The local sealed Ladybug bundle was rejected by the repository verifier:
  `Cargo.lock digest does not match the current checkout`. It was not reused.
  Required native checks use the pinned source-build fallback in this worktree.
- [First full check](full-check-initial.txt): native compilation and Clippy
  completed; Rust test compilation failed with `No space left on device` while
  writing `liblbug-51f77851a839cb55.rlib`. This is a failed gate, not a test pass.
- Recovery removed only incremental/native output created by this run inside the
  assigned worktree. The freshly compiled Ladybug library was
  [sealed](ladybug-create.txt) and [verified](ladybug-verify.txt) by the repository
  workflow against this checkout's Cargo.lock, pinned source, target and Rust
  identity. Its stripped library SHA-256 is recorded below. No unrelated cache
  or user data was removed. Full-check retry uses its verified external-link
  inputs, `CARGO_INCREMENTAL=0` and `CARGO_BUILD_JOBS=2` to reduce disk use.
- [First artifact-assisted rerun](full-check-linkage-failure.txt): failed because
  Cargo reused the old source-link build-script metadata after redundant native
  output was removed. Diagnosis confirmed that the dependency does not watch
  the external-library environment variables. `cargo clean -p lbug` invalidated
  only that package's generated state before the corrected rerun. The verified
  bundle was not changed; this setup failure is retained separately.
- [Final `npm run check`](full-check-final.txt): **passed**, exit 0. Rust
  formatting, Clippy, default Rust tests, crash-reconciliation tests, runtime
  build, workspace builds/type checks, receipt lint and PRD readability all
  completed successfully. Main Vitest: 309 files passed / 1 skipped; 3,829 tests
  passed / 3 skipped. Explicit Codex secret-boundary run: 2 tests passed. Python:
  77 tests passed. Skipped cases are not claimed as passes.
- [Final `npm run build`](build.txt): **passed**, exit 0, using the same verified
  native-library inputs and exact source identities below. The build included
  both Rust services, the root TypeScript build and all workspace package builds.
- `git diff --check`: passed. `.worktree-meta` is unchanged at SHA-256
  `87cc9a2212e234cf1d8f1ba1b32e09a9dfe579c425d69d1b7c0a8041d1d435d0`.
  At the initial local handoff, no commit, push, merge, deployment, publication
  or release had been performed.

Verified recovery-library SHA-256: `67928c1b4bccf26e78f288a747433e1b6f2076c906428545f14163e30ea36669`.

## Source identity and review

SHA-256 identities for the reviewed executable/test source:

```text
75a12946a38bd04a89052cc3c1c2d42630f3570419e5d4276e647b03bdaf8022 desktop/main/managed-runtimes/installer.mjs
2bc99faa8d61a1eb8c9ab2423ba0b139cab629ebfe1662e08c80458e9314c844 desktop/main/managed-runtimes/probes.mjs
f7b2ceca5952477947822438fcfcafccc15c59785326a2c7e8296c79b82f3f8f test/managed-runtime-installer.test.mjs
98286f4aa215865f66e03bf43680354ca390ba2a36c1ec1387343f23b528ac35 test/managed-runtime-promotion.test.mjs
```

Reviewer `/root/adversarial_review` verified the four identities above before and
after its independent 98-test installer/promotion run (two files passed). Reviewed
scope: install/update promotion, probe closure/termination, cancellation, atomic
activation, rollback, ownership, retained sessions and MRT-375-1/3/4 mapping.
Verdict: **no blocking findings**. Unresolved: affected-user locking actor,
packaged Windows proof and possible locked staging cleanup masking the original
close timeout. This review preceded the PR and was **non-certifying** at the
local handoff. Its assertion is carried into the PR against the exact reviewed
source identities; any change to those identities invalidates it.

Final heavy-evidence audit by `/root/adversarial_review`: **no blocking findings**
for this same source snapshot and unchanged `.worktree-meta`. The reviewer
checked the inner final-check/build results, separately retained setup failures,
and the admission of the recovery artifact against its retained bundle,
[persisted manifest](ladybug-manifest.json), actual full library SHA-256/size,
Cargo.lock digest, pinned lbug checksum, macOS arm64 and Rust 1.98.0 contract.
No tests were rerun for that audit. Unresolved findings are the Windows/locking
limits above. This was a **non-certifying handoff review** before the PR existed;
the PR records the same assertion against its exact source commit.

## Remaining Windows proof

Use a packaged Windows x64 build from the final exact source, under a normal
non-admin account. In a fresh Relayer profile, run the Connect-triggered exact
`codex@0.159.3` preparation and record both probe process closure and final
installation/active receipt. Repeat the update staging/activation path with a
prior installation and saved session state, then cancel preparation during
promotion. Record the app/source/runtime identities, sanitized error code and
stage, installed receipt, process state and preserved user data. This can be
inference-free. It does not authorize signing or publication.

On the affected profile, capture the original failure with process/file-handle
or filesystem tracing if it persists. That evidence is needed to attribute the
locking actor and distinguish transient lock contention from permanent denial.
A child that never confirms close must fail preparation; if the Windows lock
also prevents staging cleanup, cleanup may itself fail. This existing failure
boundary must not be interpreted as permission to delete elsewhere, broaden
ACLs or modify the previous installation. The earlier Electron localhost startup
failure has not been diagnosed by this correction.

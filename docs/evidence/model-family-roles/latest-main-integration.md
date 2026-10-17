# Latest-main integration — 2026-10-16

PR #715 is based on main `d9a26d50b9de1d9cbc61d6620fa49e71e4c7ec2a`,
including #739's relationship examples, #731's graph-search default and #732's
node-run queue. The integration preserves the role-aware producer and native
consumer from `00b870c80a658dfda27805d2f9ad6c2323b0fb31`.
This updates the draft branch; it does not merge #715 or change product defaults.

## Changed seams and verification plan

The [product portfolio](README.md), [native contract](../../contracts/harness-model-family-roles.md),
and [picker portfolio](roster-picker.md) retain the FAM-001–006 checkpoints.
This integration adds these explicit checkpoints:

- Main's migrations 1–49 retain their exact bytes and checksums; role backfill
  appends as 0050. The schema-49 backfill scenario observes upgrade and retained
  history/default/order. Existing migration scenarios remain separate boundaries.
- Queued dispatch resolves the current family at preparation and execution;
  atomic admission compares exact family, roles, revision and subscription root
  authority. Queue ownership does not grant provider admission. Queue ordering,
  independent-node concurrency, Stop, retry and persistence scenarios remain.
- Both native root and invoked prompt constructors retain #739's current graph
  presentation guidance alongside the admitted family roster. Existing native
  conversation predicates, provider ownership and graph acceptance remain.
- New-main fixture families explicitly designate an orchestrator. Neutral absent
  provider constraints are supplied to newer Rust fixture structs. No assertions
  or tests were deleted or relaxed.
- The merged renderer has a fresh actual Electron social-preview receipt;
  unchanged image bytes are not a substitute for the new source binding.

Required entry points: `npm run check`, `npm run build`,
`npm run test:eval-web`, `npm run evidence:telemetry` and
`npm run evidence:share-preview`. Live/subscription comparison is separate;
no inference belongs to these deterministic gates.

## Source identity

[latest-main-source-snapshot.json](latest-main-source-snapshot.json) binds the
109 changed files against main, before this ledger and manifest were added.
Digest: `aacf011fc370244f3b00aa5a498a0b6538014a012badb357d964ef5e8fdb91a2`.
The manifest specifies path/byte hashing and individual SHA-256 values.
Historical manifests and receipts describe their historical snapshots only.

## Actual results

- All-target/all-feature app-server Rust type checking: passed.
- `npm run build`: passed on this latest-main composition.
- Electron social-preview capture: passed, including cancellation and window/server
  cleanup. The fresh receipt binds merged renderer bytes. Light/dark PNG hashes
  remain `0d64e23622f8e4d9dbe46907c8a02a46e8e53bd4dce236d38acce53bbaaf1979`
  and `ef5bd275a7732cdcd8186e9d85bf76d3f872c9416d1dce7d661d52ee87dcf2c9`.
- `npm run check`: failed (exit 1). Formatting, Clippy, Rust workspace and
  crash reconciliation, native/package builds and type checking passed.
  Vitest: 328 files / 4,383 tests passed; one test failed; one file / three
  tests skipped. The unchanged 10,000-layer public-viewer traversal exceeded
  its 15-second bound (20.961 seconds observed). No other Vitest failure.
- Selected unchanged traversal diagnostic: passed, one test with 137 skipped,
  10.99 seconds test time. This does not convert the aggregate to a pass or
  establish the timeout's cause.
- `npm run evidence:telemetry`: passed, five Rust and 184 portfolio tests;
  verdict `local-gateway-privacy-pass-release-indeterminate`.
- Separately executed short-circuited tail: secret boundary 2/2, Python 99/99,
  Ladybug receipt/probe lints and PRD readability passed.
- `npm run test:eval-web`: failed (exit 1). Startup/lifecycle/reopen/read-only,
  host, production Settings, Human Task, actor dispatch-race, native-select,
  and redraw-action/breadcrumb chapters reported pass. `proveTaskActor`
  observed `interrupted` rather than `completed` at line 943. Its saved events
  report an actor observation timeout. Later actor-input, current-pointer,
  calibration and judge chapters were unreached. No whole-browser pass.
- No whole-portfolio pass is claimed. The live comparison remains unstarted
  while the browser actor result is unresolved.

[latest-main-verification.json](latest-main-verification.json) binds exact logs
and separates commands, actual results, and unresolved proof.

The earlier integration onto main `38682336` passed 358 focused tests and its
build. Its full check failed: six Vitest scenarios failed after Rust, crash
reconciliation, native/package builds and type checks passed. Four failures
were role-less fixture setup across provider capture, repair and invocation;
those fixtures now explicitly designate their original root. The other two
were the Homebrew Node sealing and canonical graph-authoring replay 30-second
bounds. Those original results remain failures, independent of later runs.
The focused repair fixture passed 7/7 after correction.

## Adversarial assertions

`/root/pilot_fix_authority_review`: native consumer preservation passed for the
nine-file source digest
`292b1a6395c26854aa2fc35972dbc0555bdf26f80081e9875a197460e9a54b2c`.
Scope: native root/invoked prompts and tests, V1/V2 integrity, exact-provider
selectors, graph presentation and provider ownership. No unresolved findings
in that scope; no independent test or inference execution by the reviewer.

`/root/linux_worker_authority_review`: verified all 109 manifest hashes at
`aacf011fc370244f3b00aa5a498a0b6538014a012badb357d964ef5e8fdb91a2`,
and the receipt hashes for all 10 bound source files, 101 renderer files and
both images. Receipt-excluded source digest remains
`10cb5818c56d5015f98c60b24f166a471be15848f72bb2cac3dc19d02b125c54`.
Scope: migration/history, product family resolution, queued dispatch/Stop,
atomic attempt admission, Eval selection/consent and fixture meaning.
Verdict: no unresolved source blocker in that scope. No tests or inference
were performed by this reviewer.
These assertions do not certify heavy execution, release or default promotion.

## Build-cache provenance and remaining boundaries

The repository verifier accepted the trusted macOS ARM64 Ladybug 0.18.0 cache
with Rust 1.98.0. Inspected CI artifacts were Linux and incompatible with this
Mac. Cargo dependencies were cloned into private targets; all four first-party
workspace crates were cleaned and rebuilt from source. A build started before
one clone settled was stopped (exit 130). A second overlapping copy failed on
two disappearing dependency archives; its partial target was rejected and
removed, then copied after compilation settled. Rejection details and original
logs remain private under the comparison run directory. Cached test outcomes
were never used.

Use fresh comparison databases: a development database that previously used
migration 49 for roles cannot be reopened with main's 49=node queue and
50=roles. No existing user database was rewritten for this comparison.
Physical trackpad feel and the historical live-model quality findings remain
unverified or unresolved as recorded in [pr-handoff.md](pr-handoff.md).
No API/Prime spending, #715 merge or product-default promotion is authorized
by this branch update.

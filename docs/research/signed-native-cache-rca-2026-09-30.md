# RCA: signed native cache fails to seed

Date: 2026-09-30. Analysis only; no implementation or release rerun.

Reviewed source: `3dc56dd9cff4bd1fd9c1faaf199ed195578a7224`.

## Finding

The signed-native cache repeatedly fails during production of its debug-symbol payload. Both Preview 0.2.34 and 0.2.35 compiled from source and then rejected cache sealing with `incomplete dSYM generation diagnostics`. Consequently, those successful releases did not produce reusable native-cache artifacts.

The leading explanation is a lifecycle mismatch: cache sealing runs `dsymutil` after Cargo finishes, while the executable's debug map can reference temporary Ladybug archives that are no longer available. Later symbol generation in the same runs explicitly reports those missing archives. This underlying mechanism is strongly supported, but the original cache-sealing diagnostics were discarded, so it is not conclusively proven for the first invocation.

This is a cache-producer failure. A cache-key collision, corrupt downloaded artifact, or failed release is not demonstrated by this evidence.

## Evidence and impact

| Observation | Evidence | Interpretation |
| --- | --- | --- |
| 0.2.34 reports no compatible cache, then symbol-related save failure | [Candidate run 36659090213](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/36659090213) | Repeated producer failure predates this release |
| 0.2.35 reports the same miss and save failure | [Candidate run 36676794849](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/36676794849) | Failure repeated on the reviewed source |
| Rust release compilation takes 17m 39s | 0.2.35 candidate log, completion at 06:29:40 UTC | Material cost of compiling on a miss; not the measured savings of a successful hit |
| Cache save fails at 06:29:53 UTC | Same log | Failure follows successful Cargo completion |
| Later telemetry emits missing `release/deps/rustc…/liblbug.a(member.o)` warnings | Same log around 06:38:19 UTC; also present in 0.2.34 | Direct evidence that original Ladybug archive references are unavailable at later symbol generation |
| No signed-native artifacts among the 500 recent artifacts searched | Five artifact API pages, 100 entries each | No reusable seed within the workflow's bounded search window; not a claim about all repository history |
| Release, signature, notarization and updater canary pass | [Publication](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/36679611916), [canary](https://github.com/vishaltandale00/relayer-graphcomplete/actions/runs/36679950712) | Distribution succeeded despite failed optional cache creation |

0.2.35's signed-candidate job took approximately 30 minutes. Native compilation was the largest measured component. Local Node-version mistakes and repeated verification also delayed the overall release, but they did not cause the hosted native-cache failure.

## Causal chain established by source

1. The manual signed workflow enables the signed-native cache and searches for compatible, trusted artifacts.
2. No compatible artifact is found, so the builder prepares pinned native dependencies and runs Cargo with release `debug=1`.
3. Only after Cargo exits does the builder call `sealSignedNative`.
4. Sealing runs `dsymutil` again for the runtime binaries. `generateSignedSymbols` rejects any output matching `warning`, `error`, or `no debug symbols`, even when the tool exits successfully.
5. The resulting exception aborts sealing. The builder catches it and logs a generic save-unavailable message, then retains the successful fresh binaries.
6. The native-artifact workflow outputs are written only after sealing succeeds. Without them, the conditional native-cache upload has nothing to publish.
7. Subsequent compatible builds cannot reuse this run's output because no sealed cache was uploaded.

Relevant immutable source:

- [Build and seal ordering; fallback and workflow outputs](https://github.com/vishaltandale00/relayer-graphcomplete/blob/3dc56dd9cff4bd1fd9c1faaf199ed195578a7224/desktop/release/build-release.mjs#L81-L105).
- [Symbol diagnostic rejection and payload sealing](https://github.com/vishaltandale00/relayer-graphcomplete/blob/3dc56dd9cff4bd1fd9c1faaf199ed195578a7224/desktop/packaging/signed-native-cache.mjs#L73-L102).
- [Signed workflow](https://github.com/vishaltandale00/relayer-graphcomplete/blob/3dc56dd9cff4bd1fd9c1faaf199ed195578a7224/.github/workflows/desktop-signed-preview.yml).

## Leading underlying cause and confidence limits

LLVM documents that `dsymutil` collects debug information from the object files referenced by the executable. Its debug-map dump can identify those required files. [LLVM documentation](https://llvm.org/docs/CommandGuide/dsymutil.html).

Rust documents that macOS normally uses packed debug information, producing a dSYM, and that temporary compilation files are deleted by default when compilation finishes. [Rust code-generation documentation](https://doc.rust-lang.org/rustc/codegen-options/index.html#split-debuginfo), [temporary-file behavior](https://doc.rust-lang.org/rustc/codegen-options/index.html#save-temps).

The cache implementation assumes all necessary Cargo objects still exist after Cargo returns. The later missing-archive diagnostics challenge that assumption. Regenerating symbols at this point may be too late; compiler-produced symbols may already have been generated while the temporary inputs existed.

However, the first failing `dsymutil` stdout/stderr is captured and replaced with a generic exception. The precise warning that triggered that first rejection is unavailable. The later warning is strong corroboration, not a recording of the earlier invocation. Existing compiler-produced dSYMs, their completeness, the actual compiler invocation, and exact cleanup timing were not inspected on the hosted runner.

Alternative explanations to distinguish include a path-remapping problem, missing debug information in the native archive itself, and another toolchain warning triggering the broad rejection rule.

## Why telemetry can succeed while cache saving fails

After cache failure, telemetry runs `dsymutil` through a different path and correlates the resulting debug identity with the packaged binary. That fallback does not apply the cache's warning rejection. Thus successful release telemetry does not contradict cache rejection. Matching UUIDs or some compilation units alone also do not establish complete Ladybug symbol coverage.

[Telemetry fallback](https://github.com/vishaltandale00/relayer-graphcomplete/blob/3dc56dd9cff4bd1fd9c1faaf199ed195578a7224/desktop/release/telemetry-artifacts.mjs#L305-L320).

No binary corruption or user-data loss was observed. Complete native crash-symbol coverage remains unproven by this analysis.

## Legitimate misses remain distinct

CI's development/debug caches and signed release caches have different contracts. Signed reuse binds native inputs, target, profile, toolchain, packaging implementation and provenance.

PR #619 changed native Rust inputs between 0.2.34 and 0.2.35. A healthy 0.2.34 cache could therefore legitimately be incompatible with 0.2.35. The evidence establishes failure to seed the cache, not that the latest release should have reused an older incompatible runtime.

## Repair investigation, in priority order

1. Preserve bounded, redacted first-seal diagnostics, binary name and tool versions. Capture the debug map and existence of its referenced archives immediately after Cargo returns. This closes the observability gap without weakening validation.
2. Inspect compiler-produced dSYMs from the exact release build. If present and complete, validate and preserve them for both caching and telemetry instead of regenerating them after temporary inputs disappear. Existence alone is insufficient: verify architecture, UUIDs, DWARF integrity, expected native symbol coverage, hashes and inventory.
3. If compiler-produced symbols are incomplete, investigate native archive generation and object lifetimes. Evaluate retaining the necessary temporary inputs or using stable archive paths. `save-temps` is an experiment, not a verified fix; prove it preserves the particular inputs required by this binary.
4. Make cache outcomes visible in job summaries: lookup result, rejection category, sealing result, upload result and immutable artifact identity. Preserve fresh-build fallback while distinguishing cache degradation from a successful seed.

Do not solve this by ignoring all warnings, caching bare binaries, importing CI debug binaries, or weakening source/profile/provenance checks. Changes to symbol generation must enter the cache identity.

## Verification required before claiming a fix

- A small real Rust/native-library fixture must reproduce the post-Cargo symbol boundary and demonstrate complete symbol production through the proposed repair. Existing mocked cache tests and warning-rejection tests do not prove this object-lifetime boundary.
- Deterministic tests must continue rejecting incomplete symbols, UUID/hash mismatches, malformed inventories, untrusted producers and incompatible identities.
- An authorized exact-source signed candidate must successfully seal and upload a native-cache artifact with verified binaries and dSYMs.
- A second authorized compatible-input candidate must restore that immutable artifact and prove fresh native compilation was skipped, while retaining required source CI, symbol validation, signing, notarization and publication gates.
- Measure hit versus miss timings. A successfully written manifest or passing unit test is insufficient evidence of a hosted cache hit.

No implementation tests or cold native builds were run for this RCA. Analysis used repository source, two completed hosted logs, artifact listings and primary toolchain documentation. Any future build must follow the trusted-cache preparation contract before compiling.

## Adversarial review

Reviewer `/root/review_preview` examined source `3dc56dd9cff4bd1fd9c1faaf199ed195578a7224` and both candidate logs. Verdict: the repeated cache-production failure is confirmed; the temporary-archive explanation is the leading inference and must not be presented as conclusively reproduced. Compiler-produced dSYM reuse is the first repair candidate, conditional on inspection and completeness validation. This analysis review is non-certifying and provides no implementation or hosted repair proof.

# Issue #261 LadybugDB qualification

Decision date: 2026-08-28

Decision: **UPSTREAM ARTIFACTS NO-GO; PINNED 0.18.0 SOURCE ROUTE PASSES MACOS LOCALLY; OVERALL GATE BLOCKED**

Contract under test: `relayer.graph-query` version 1 from Issue #260

This is a feasibility-gate result, not a change to the graph-search product contract. Ladybug
remains the required engine from the first enabled graph-search path, SQLite remains canonical,
and no SQLite search fallback is permitted. Production projection work must not begin until the
remaining Windows runtime and binding-license boundaries below are resolved and
this gate is rerun.

## Exact candidate

| Component | Pin | Receipt |
| --- | --- | --- |
| Ladybug core | `v0.18.0`, commit `0cda4fffcebb4a52cc24198462901ad28e2d5b66` | exact source embedded in the pinned crate |
| Rust binding | crates.io `lbug = "=0.18.0"` | crate SHA-256 `f52ee74966e323212747aa22fa8c01f73f1cbbb996187c3b08cbf96ff9f67562` |
| Extensions | none | structural v1 needs no Ladybug extension |
| OpenSSL source candidate | `3.5.8` LTS | source SHA-256 `a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2`; Apache-2.0; supported through 2030-04-08 |

The rejected 0.19.1 release artifacts remain frozen in
`fixtures/ladybug-v0.19.1-qualification.json`. The active 0.18.0 source pin is frozen in
`vendor/ladybug/source-build-manifest.json`. The crate embeds the official core source and can
build it with `LBUG_BUILD_FROM_SOURCE=1`. Its default build path is unsuitable for Relayer: absent
`LBUG_VERSION`, the included downloader selects the latest release. If that script is removed, a
fallback fetches a replacement from upstream `main`. Any future integration must force checked,
application-owned inputs and must fail if a build attempts network access.
The crate is the exact binding pin. Its metadata names source-basis commit
`ea283cd1bf5473cd5c233944e3b281eb0d758a45` with `dirty: true`; the version bump and vendored core
mean that commit alone is not an exact substitute for the crate bytes.

## What passed

- The exact unmodified 0.18.0 binding and core build from reviewed source bytes on macOS arm64 and
  Intel with
  pinned static-only OpenSSL 3.5.8, Cargo offline, and operating-system network access denied. The
  resulting binary targets macOS 13.3 and imports only system `libiconv`, libc++, and libSystem; it
  has no undefined OpenSSL symbols and needs no Ladybug/OpenSSL dylib or rpath.
- All 20 positive v1 cases execute through contract-private Ladybug lowerings and deep-compare
  exactly with the frozen columns, ordered rows, tagged values, graph identities/properties, path
  order, and truncation flags. Node, layer, relationship, path, list, record, null, and scalar
  values round-trip without string coercion.
- A probe transaction rolls back across database reopen. The qualified profile loads no extensions.
- `PreparedStatement::is_read_only` provides the positive parsed read-only hook needed after
  Relayer's own bounded parser and typed planner.
- The allowed two-hop probe demonstrates both a one-millisecond timeout and explicit interrupt.
  Relayer still owns deterministic traversal, expansion, intermediate-row, output, and process
  deadlines at the #263 wrapper boundary.
- No binding patch, core fork, or extension is required. Relayer supplies only target-specific
  static OpenSSL search paths and library names that 0.18.0 omits from its Cargo build metadata.

The dialect needs contract-private lowering: Ladybug emits both orientations for an undirected
relationship match, rejects `NULLS FIRST` and `NULLS LAST`, and has no v1 `IS ABSENT` spelling.
Relayer can lower these behind the typed plan with canonical orientation/deduplication, explicit
null sort keys, and private property-presence columns. Those are implementation obligations for
Issue #263, not public contract changes.

An earlier unbounded cancellation falsifier remains relevant but is not an admitted v1 query. A
one-millisecond timeout did not interrupt
`UNWIND range(1,1000000000) AS x RETURN sum(x)` within 30 seconds; the probe was killed. Ladybug's
cooperative checks can be starved by this range/aggregate plan, and there is no native counter for
v1 examined-expansion or intermediate-row budgets. The allowed two-hop cancellation probe passes,
but Issue #263 must still enforce its deterministic parser/planner budgets and an outer process
deadline rather than treating the engine methods as the complete authority boundary.

## Release-blocking finding

The official native artifacts are not self-contained application-owned runtime bytes:

- The macOS arm64 shared library imports
  `/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib` and `libcrypto.3.dylib`.
- The macOS Intel shared library imports
  `/usr/local/opt/openssl@3/lib/libssl.3.dylib` and `libcrypto.3.dylib`.
- The Windows x64 DLL imports `libssl-3-x64.dll` and `libcrypto-3-x64.dll`.
- The same Windows DLL imports `MSVCP140.dll`, `VCRUNTIME140.dll`, and `VCRUNTIME140_1.dll`; the
  Ladybug archive does not carry or receipt them.
- Both official macOS shared libraries declare macOS 13.3 as their minimum runtime. This was read
  from `LC_BUILD_VERSION` with `vtool`. The product decision now raises Relayer's floor to macOS
  13.3 and protects 13.0–13.2 updater cohorts with the Darwin 22.4.0 manifest floor.
- The release archives contain Ladybug headers/libraries but not those OpenSSL libraries. The
  current Rust static-link path also emits dynamic OpenSSL link directives, so choosing the static
  Ladybug archive does not remove the runtime dependency. A local arm64 probe linked directly to
  the Homebrew OpenSSL paths.
- The upstream macOS libraries are only linker ad-hoc signed. Bundling the shared form would require
  install-name rewriting followed by Relayer's authenticated signing and verification.

The pinned source-build experiment explains the compatibility boundary. OpenSSL 3.5.8
built as only `libssl.a` and `libcrypto.a` for macOS 13.0, but Ladybug 0.19.1 could not compile at
that floor because Apple makes its C++20 floating-point `std::to_chars` path available only from
macOS 13.3. After the approved floor change, the exact unmodified `lbug` crate linked against the
pinned static-only OpenSSL prefix with `LIBRARY_PATH`; no binding or core patch is required.

Ladybug 0.18.0 predates the Apple-Clang AVX2 runtime check that made 0.19.1 reference unavailable
`___cpu_model` bytes on Intel. The exact 0.18.0 source route links and runs on both macOS targets at
the approved 13.3 floor. Both binaries import only system `libiconv`, libc++, and libSystem.

The checked-in source manifest and preparation utility now own and receipt the OpenSSL source and
emit a static-only prefix plus offline Cargo environment. The packaging build adds deterministic,
target-specific static OpenSSL link metadata without changing Ladybug source bytes. The graph-server
lifecycle passes locally on arm64 and under Rosetta for Intel.

The same Relayer-owned adapter maps the Windows target to the prepared `libssl.lib` and
`libcrypto.lib` archives. Upstream has independently merged the Windows discovery/naming fix in
LadybugDB/ladybug-rust#26, but crates.io 0.19.1 predates it. The adapter is deterministically tested;
its native Windows build and lifecycle remain unverified until the hosted runner can test this exact
source snapshot.

The native receipt now inventories all 27 core subtrees and 22 compiled components, pins exact
source-tree and notice digests, and covers the core, OpenSSL, and transitive native notices. One
external distribution blocker remains: the crates.io `lbug` 0.18.0 archive declares MIT but neither
it nor its source-basis repository ships a binding license file. The fail-closed release-ready
receipt must continue to reject release readiness until reviewed upstream license bytes are
available. The focused upstream request is LadybugDB/ladybug-rust#29.

## Evidence commands and limits

The exact checks used for this decision were:

```sh
cargo info lbug@0.18.0
LBUG_VERSION=0.18.0 cargo run --release
otool -L target/release/ladybug-probe
otool -L liblbug.0.19.1.dylib
llvm-objdump -p lbug_shared.dll
vtool -show-build liblbug.0.19.1.dylib
npm run ladybug:source -- verify --cache /absolute/cache
npm run ladybug:source -- prepare --cache /absolute/cache --output /absolute/empty/output --target aarch64-apple-darwin
cargo build --release --locked --offline
npm run lint:ladybug-contract-probe
npm run lint:ladybug-receipt
```

The historical macOS 13.0 failure and temporary binding-hook experiment remain preserved beside the
original probe. They are superseded by `vendor/ladybug/source-build-manifest.json` and
`scripts/prepare-ladybug-source.mjs`: the accepted macOS 13.3 route uses the exact unmodified crate,
embedded core, and static OpenSSL source bytes.

The upstream release digests were independently compared to the downloaded arm64, Intel, and
Windows shared archives. The pinned source build and full contract probe were executed on macOS
arm64. Cross-target packaged launch, signing, and release evidence remain unproven; source and API
inspection are not substitutes for those runtime boundaries.

The superseded 0.19.1 Intel attempt is retained in `issue-261-ladybug-intel-link-blocker.txt`. It used an exact clean
checkout, offline lockfile install, empty Cargo target, x86_64 static OpenSSL, and Rosetta. Ladybug's
`base_csv_reader.cpp` selects `__builtin_cpu_supports("avx2")` for Apple Clang, producing an unresolved
`___cpu_model` reference. Upstream now tracks that defect in LadybugDB/ladybug#848. The 0.18.0 pin
avoids the regression without a fork.

The original focused probe and historical cancellation falsifier are in
`issue-261-ladybug-probe/`. The 0.18.0 exact-envelope corpus probe, captured output, lockfile,
coverage, and digest receipt are in `issue-261-ladybug-contract-probe/`. The checked-in arm64 source
and package observations still describe the preceding 0.19.1 qualification and remain historical
until the clean detached 0.18.0 captures replace them. Current local arm64 and Intel results are
non-certifying until those receipts bind an exact commit.

Source identity was checked with recursive diffs. The crate's packaged
`lbug-src/{src,cmake,third_party,CMakeLists.txt,tools/CMakeLists.txt}` bytes match core tag v0.18.0.
Binding sources excluding Cargo manifests and the added vendored core match the source-basis commit.

## Acceptance ledger

| Issue #261 checkpoint | Result | Evidence or gap |
| --- | --- | --- |
| Golden corpus or approved lowering | Passed locally | All 20 positive cases deep-compare exactly through documented contract-private lowerings. |
| Lossless v1 value round-trip | Passed locally | Exact tagged envelopes cover scalar, null, list, record, node, layer, relationship, and path values. |
| Application-owned offline load | Passed on macOS | Exact unmodified source and static OpenSSL build/run on arm64 and Intel without non-system dylibs. |
| Three packaged development targets | Blocked | Both macOS targets link and pass the local lifecycle; the deterministic Windows adapter lacks native hosted-runner proof. Distribution is also blocked by missing binding license bytes. |
| Pinned source build at product floor | Passed on macOS | Exact Ladybug 0.18.0 and OpenSSL 3.5.8 build at the approved macOS 13.3 floor with no fork or external dylib. |
| Packaged launch, restart, lock, shutdown | Passed on macOS | The graph server creates a clean store, rejects a bounded competing lock, exits cleanly, and reopens its persisted marker on arm64 and Intel/Rosetta. |
| Cancellation and budgets | Partial pass | Allowed two-hop timeout/interrupt pass; #263 still owns deterministic budget counters and an outer process deadline. |
| Complete license receipts | Blocked externally | Core/OpenSSL/transitive native inventory passes; upstream binding license bytes are absent. |
| No permanent Ladybug fork | Passed locally | Exact unmodified 0.18.0 plus Relayer-owned link metadata works with `extensions=[]`. |
| Explicit go/no-go before projection | Passed | Upstream artifacts are NO-GO and the source route is not yet fully qualified; dependent DAG nodes remain blocked. |

## Remaining gate work

Keep the product contract unchanged and hold Issues #262 onward. Pinned static OpenSSL and the
macOS 13.3 product floor are settled; deterministic updater tests preserve the last compatible
release for macOS 13.0–13.2. The 0.18.0 graph-server lifecycle passes locally on both macOS targets.
Windows still needs a native build and lifecycle replay of the checked-in link adapter.

The repository already has macOS arm64, macOS Intel, and Windows x64 hosted package runners in
`.github/workflows/ci.yml`. They cannot certify this unpushed worktree. Windows Authenticode is
also disabled in the signed workflow, independently of this qualification. Finally, obtain reviewed upstream license bytes for the
`lbug` binding or an explicit legal disposition; the fail-closed release-ready receipt must remain
red until then. These are proof limits, not reasons to weaken packaging, signing, or license gates.

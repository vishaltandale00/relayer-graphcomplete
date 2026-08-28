# Issue #261 LadybugDB qualification

Decision date: 2026-08-28

Decision: **UPSTREAM ARTIFACTS NO-GO; PINNED SOURCE ROUTE LOCALLY VIABLE; OVERALL GATE BLOCKED**

Contract under test: `relayer.graph-query` version 1 from Issue #260

This is a feasibility-gate result, not a change to the graph-search product contract. Ladybug
remains the required engine from the first enabled graph-search path, SQLite remains canonical,
and no SQLite search fallback is permitted. Production projection work must not begin until the
remaining packaged-lifecycle, cross-target, and binding-license boundaries below are resolved and
this gate is rerun.

## Exact candidate

| Component | Pin | Receipt |
| --- | --- | --- |
| Ladybug core | `v0.19.1`, commit `554c1e71158564c37a30c541a92bfc9eddc96430` | official release artifacts and the source embedded in the crate |
| Rust binding | crates.io `lbug = "=0.19.1"` | crate SHA-256 `a7a032d5968ac2260545e8c5cf05a123559de2c6ba2bd0dde11c0ed958dfa172` |
| Extensions | none | structural v1 needs no Ladybug extension |
| OpenSSL source candidate | `3.5.8` LTS | source SHA-256 `a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2`; Apache-2.0; supported through 2030-04-08 |

The machine-readable artifact names and upstream SHA-256 digests are frozen in
`fixtures/ladybug-v0.19.1-qualification.json`. The crate embeds the official core source and can
build it with `LBUG_BUILD_FROM_SOURCE=1`. Its default build path is unsuitable for Relayer: absent
`LBUG_VERSION`, the included downloader selects the latest release. If that script is removed, a
fallback fetches a replacement from upstream `main`. Any future integration must force checked,
application-owned inputs and must fail if a build attempts network access.
The crate is the exact binding pin. Its metadata names source-basis commit
`2e89afb712e6e26f2465f486b153e4aea1176130` with `dirty: true`; the version bump and vendored core
mean that commit alone is not an exact substitute for the crate bytes.

## What passed

- The exact unmodified 0.19.1 binding and core build from reviewed source bytes on macOS arm64 with
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
- No binding patch, core fork, or extension is required for the structural v1 seam found so far.

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

The pinned source-build experiment explains and resolves the compatibility boundary. OpenSSL 3.5.8
built as only `libssl.a` and `libcrypto.a` for macOS 13.0, but Ladybug 0.19.1 could not compile at
that floor because Apple makes its C++20 floating-point `std::to_chars` path available only from
macOS 13.3. After the approved floor change, the exact unmodified `lbug` crate linked against the
pinned static-only OpenSSL prefix with `LIBRARY_PATH`; no binding or core patch is required.

The failure and successful 13.3 replay were observed natively on macOS arm64. The macOS Intel
consequence is inferred from the shared Apple SDK and libc++ availability boundary; it still needs
a native Intel replay. The final unmodified source probe built with network denied, imported only
system `libiconv`, libc++, and libSystem, embedded OpenSSL 3.5.8, and had SHA-256
`a3e98e731252fc43cfaceafc6bee8fc997d24cccf2d22ef8952c83e716c6822a`.

The checked-in source manifest and preparation utility now own and receipt the OpenSSL source and
emit a static-only prefix plus offline Cargo environment. That resolves the native dependency
design locally. The actual packaged graph-server lifecycle now passes on macOS arm64. macOS Intel
still needs native replay, while Windows has the separate static-link blocker below.

The unmodified Windows binding emits `ssl` and `crypto` link names, while the pinned OpenSSL MSVC
build installs `libssl.lib` and `libcrypto.lib` and supplies no verified static-library search path.
The source preparation manifest therefore marks Windows x64 unsupported and fails closed rather
than pretending that the macOS `LIBRARY_PATH` strategy transfers to MSVC.

The native receipt now inventories all 27 core subtrees and 22 compiled components, pins exact
source-tree and notice digests, and covers the core, OpenSSL, and transitive native notices. One
external distribution blocker remains: the crates.io `lbug` 0.19.1 archive declares MIT but neither
it nor its source-basis repository ships a binding license file. The fail-closed release-ready
receipt must continue to reject packaging until reviewed upstream license bytes are available.

## Evidence commands and limits

The exact checks used for this decision were:

```sh
cargo info lbug@0.19.1
LBUG_VERSION=0.19.1 cargo run --release
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

The original focused probe and historical cancellation falsifier are in
`issue-261-ladybug-probe/`. The exact-envelope corpus probe, captured output, lockfile, coverage,
and digest receipt are in `issue-261-ladybug-contract-probe/`. The source-build observation is in
`issue-261-ladybug-source-arm64.txt` and is bound by the source-build manifest/test. The fresh
packaged graph-server lifecycle receipt is `issue-261-ladybug-packaged-arm64.json`; it binds the selected
checked-in qualification inputs and packaged binary digest to exact commit `77934418e355f2207fb59605cc3b0b39f42dfcd0`.
The capture used a clean detached checkout, empty Cargo target, exact lockfile installed offline, and regenerated
workspace assets before electron-builder ran. The replay used macOS 26.6.1, Xcode SDK 26.2, Apple clang
17.0.0, Rust 1.94.0, Cargo 1.94.0, CMake 4.3.1, and macOS
arm64. The temporary executable and full compiler log are not checked in; their digests and exact
proof limit are retained in the observation.

Source identity was checked with recursive diffs. The crate's packaged
`lbug-src/{src,cmake,third_party,CMakeLists.txt,tools/CMakeLists.txt}` bytes match core tag v0.19.1.
Binding sources excluding Cargo manifests and the added vendored core match the source-basis commit.

## Acceptance ledger

| Issue #261 checkpoint | Result | Evidence or gap |
| --- | --- | --- |
| Golden corpus or approved lowering | Passed locally | All 20 positive cases deep-compare exactly through documented contract-private lowerings. |
| Lossless v1 value round-trip | Passed locally | Exact tagged envelopes cover scalar, null, list, record, node, layer, relationship, and path values. |
| Application-owned offline load | Passed arm64 | Exact unmodified source and static OpenSSL build/run with network denied, then travel inside the bundled graph server without non-system dylibs. |
| Three packaged development targets | Blocked | The exact-source macOS arm64 lifecycle passes; Intel needs native replay; unmodified lbug has a concrete MSVC static-library name/search-path blocker. Distribution is also blocked by missing binding license bytes. |
| Pinned source build at product floor | Passed arm64 | Exact Ladybug 0.19.1 and OpenSSL 3.5.8 build at the approved macOS 13.3 floor with no fork or external dylib. |
| Packaged launch, restart, lock, shutdown | Passed arm64 | The bundled `relayer-graph-server` creates a clean store, rejects a bounded competing lock, exits cleanly, and reopens its persisted marker. |
| Cancellation and budgets | Partial pass | Allowed two-hop timeout/interrupt pass; #263 still owns deterministic budget counters and an outer process deadline. |
| Complete license receipts | Blocked externally | Core/OpenSSL/transitive native inventory passes; upstream binding license bytes are absent. |
| No permanent Ladybug fork | Passed locally | The exact unmodified binding/core plus static OpenSSL route works with `extensions=[]`. |
| Explicit go/no-go before projection | Passed | Upstream artifacts are NO-GO and the source route is not yet fully qualified; dependent DAG nodes remain blocked. |

## Remaining gate work

Keep the product contract unchanged and hold Issues #262 onward. Pinned static OpenSSL and the
macOS 13.3 product floor are settled; deterministic updater tests preserve the last compatible
release for macOS 13.0–13.2. The actual packaged graph-server lifecycle passes locally on macOS
arm64. Run the same pinned source/package boundary natively on macOS Intel. Windows needs a narrow
upstream binding link-resolution hook or an explicitly approved equivalent before native replay.

The repository already has macOS arm64, macOS Intel, and Windows x64 hosted package runners in
`.github/workflows/ci.yml`. They cannot certify this unpushed worktree. Windows Authenticode is
also disabled in the signed workflow, independently of the static-link blocker. Finally, obtain reviewed upstream license bytes for the
`lbug` binding or an explicit legal disposition; the fail-closed release-ready receipt must remain
red until then. These are proof limits, not reasons to weaken packaging, signing, or license gates.

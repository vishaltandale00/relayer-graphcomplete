# Issue #261 LadybugDB qualification

Decision date: 2026-08-28

Decision: **UPSTREAM ARTIFACTS NO-GO for production integration**

Contract under test: `relayer.graph-query` version 1 from Issue #260

This is a feasibility-gate result, not a change to the graph-search product contract. Ladybug
remains the required engine from the first enabled graph-search path, SQLite remains canonical,
and no SQLite search fallback is permitted. Production projection work must not begin until the
native-runtime blocker below is resolved and this gate is rerun.

## Exact candidate

| Component | Pin | Receipt |
| --- | --- | --- |
| Ladybug core | `v0.19.1`, commit `554c1e71158564c37a30c541a92bfc9eddc96430` | official release artifacts and the source embedded in the crate |
| Rust binding | crates.io `lbug = "=0.19.1"` | crate SHA-256 `a7a032d5968ac2260545e8c5cf05a123559de2c6ba2bd0dde11c0ed958dfa172` |
| Extensions | none | structural v1 needs no Ladybug extension |

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

- The exact 0.19.1 core loads embedded through Rust on macOS arm64. A release probe created a
  database and node table, inserted a node, returned the node plus its string property, and reported
  storage version 43.
- The binding exposes typed null, boolean, signed integer, floating-point, string, node,
  relationship, recursive-path, homogeneous-list, and struct values without requiring string
  coercion.
- `PreparedStatement::is_read_only` provides the positive parsed read-only hook needed after
  Relayer's own bounded parser and typed planner.
- The binding exposes `Connection::set_query_timeout` and `Connection::interrupt` as candidate
  cancellation hooks. They did not yet demonstrate enforcement for every v1 budget.
- A fixed path is returned as `RecursiveRel`, including the full ordered vertex sequence and
  relationships, and is normalizable into the v1 path wire value.
- No permanent core fork or extension is needed for the structural engine/query seam found so far.

The dialect needs contract-private lowering: Ladybug emits both orientations for an undirected
relationship match, rejects `NULLS FIRST` and `NULLS LAST`, and has no v1 `IS ABSENT` spelling.
Relayer can lower these behind the typed plan with canonical orientation/deduplication, explicit
null sort keys, and private property-presence columns. Those are implementation obligations for
Issue #263, not public contract changes.

Cancellation is not yet qualified. A one-millisecond timeout did not interrupt
`UNWIND range(1,1000000000) AS x RETURN sum(x)` within 30 seconds; the probe was killed. Ladybug's
cooperative checks can be starved by this range/aggregate plan, and there is no native counter for
v1 examined-expansion or intermediate-row budgets. Issue #263 must prove a bounded lowering or
wrapper strategy rather than treating the exposed methods as enforcement.

## Release-blocking finding

The official native artifacts are not self-contained application-owned runtime bytes:

- The macOS arm64 shared library imports
  `/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib` and `libcrypto.3.dylib`.
- The macOS Intel shared library imports
  `/usr/local/opt/openssl@3/lib/libssl.3.dylib` and `libcrypto.3.dylib`.
- The Windows x64 DLL imports `libssl-3-x64.dll` and `libcrypto-3-x64.dll`.
- The same Windows DLL imports `MSVCP140.dll`, `VCRUNTIME140.dll`, and `VCRUNTIME140_1.dll`; the
  Ladybug archive does not carry or receipt them.
- Both official macOS shared libraries declare macOS 13.3 as their minimum runtime, while Relayer's
  signed-candidate contract supports macOS 13.0 and newer. This was read from `LC_BUILD_VERSION`
  with `vtool`; it can be remedied only by an exact source rebuild targeting 13.0 plus oldest-OS
  runtime evidence, not by silently raising the product floor.
- The release archives contain Ladybug headers/libraries but not those OpenSSL libraries. The
  current Rust static-link path also emits dynamic OpenSSL link directives, so choosing the static
  Ladybug archive does not remove the runtime dependency. A local arm64 probe linked directly to
  the Homebrew OpenSSL paths.
- The upstream macOS libraries are only linker ad-hoc signed. Bundling the shared form would require
  install-name rewriting followed by Relayer's authenticated signing and verification.

Relayer Desktop neither owns nor receipts these OpenSSL bytes today. A clean user profile can
therefore fail before the graph server starts, and the repository's packaging/signing pipeline has
no declared rule for locating, rewriting, sealing, licensing, and updating them. Consequently no
honest macOS arm64, macOS Intel, or Windows x64 packaged-development proof can be produced from the
pinned upstream artifacts.

There is also no complete shippable license bundle in the upstream binary archives. The core repo
has an MIT license and the Rust crate manifest declares MIT. However, neither the crates.io 0.19.1
archive nor the binding repo carries a binding license file. Binary archives omit core and
transitive native notices, and the core's `third_party/versions.txt` has unknown versions. The
vendored source has individual third-party license files, but Relayer has no shipped-file inventory
or notice-generation rule.

## Evidence commands and limits

The exact checks used for this decision were:

```sh
cargo info lbug@0.19.1
LBUG_VERSION=0.19.1 cargo run --release
otool -L target/release/ladybug-probe
otool -L liblbug.0.19.1.dylib
llvm-objdump -p lbug_shared.dll
vtool -show-build liblbug.0.19.1.dylib
npm run lint:ladybug-receipt
```

The upstream release digests were independently compared to the downloaded arm64, Intel, and
Windows shared archives. The probe was executed on macOS arm64. Cross-target packaged launch,
restart/file-locking, shutdown, signing, extension loading, transaction rollback, cancellation
under load, and the complete golden corpus were deliberately not claimed after the common native
runtime blocker was established. API/source inspection is feasibility evidence, not packaged
runtime evidence.

The checked-in probe source and captured successful output are beside this document in
`issue-261-ladybug-probe/`. The cancellation falsifier is opt-in because it did not finish within
30 seconds. The receipt lint checks frozen identifiers and structural completeness. It does not
fetch upstream bytes, independently verify hashes, or turn the captured probe into packaged proof.
The replay used Rust 1.94.0, Cargo 1.94.0, CMake 4.3.1, macOS arm64, and lockfile SHA-256
`c37783381fe8f6ea3a21a997a2304b55b66d335ce12df0e081d6ca73776ce5da`.

Source identity was checked with recursive diffs. The crate's packaged
`lbug-src/{src,cmake,third_party,CMakeLists.txt,tools/CMakeLists.txt}` bytes match core tag v0.19.1.
Binding sources excluding Cargo manifests and the added vendored core match the source-basis commit.

## Acceptance ledger

| Issue #261 checkpoint | Result | Evidence or gap |
| --- | --- | --- |
| Golden corpus or approved lowering | Not proven | Focused dialect probes found viable lowerings; the complete corpus was not executed. |
| Lossless v1 value round-trip | Not proven | Binding types and focused graph/list/record/path rows passed; the complete value corpus did not run. |
| Application-owned offline load | Failed | Default acquisition is network-capable and shipped native bytes retain unowned runtime dependencies. |
| Three packaged development targets | Failed with release blocker | OpenSSL affects all targets; macOS prebuilt minimum is 13.3; hosted runners did not test this worktree. |
| Packaged launch, restart, lock, shutdown | Not run | No candidate passed the native dependency gate. |
| Cancellation and budgets | Failed | Timeout and cross-thread interrupt did not stop the adversarial aggregate within 30 seconds. |
| Complete license receipts | Failed | Binding/core/native binary notices and exact transitive inventory are incomplete. |
| No permanent Ladybug fork | Conditionally passed | Structural v1 needs no extension/core fork; a narrow upstream build hook remains the preferred remedy. |
| Explicit go/no-go before projection | Passed | Upstream 0.19.1 artifacts as shipped are NO-GO; dependent DAG nodes remain blocked. |

## Required decision to resume

Keep the product contract unchanged and hold Issues #262 onward. Choose and approve one native
supply-chain design, then rerun #261 on all three targets:

1. Prefer an exact source build with an official/upstream narrow hook that permits Ladybug and its
   Rust binding to link a pinned OpenSSL statically from checked bytes and target macOS 13.0; or
2. authorize Relayer to own pinned OpenSSL dynamic libraries, install-name/rpath rewriting,
   platform signing, license notices, vulnerability updates, and clean-profile packaging tests.

The first option is recommended because it keeps the shipped graph server self-contained and
minimizes a new desktop native-dependency lifecycle. It may use an upstreamed binding/build hook;
it must not become a permanent Ladybug core fork.

The repository already has macOS arm64, macOS Intel, and Windows x64 hosted package runners in
`.github/workflows/ci.yml`. They cannot certify this unpushed worktree. Windows Authenticode is
also disabled in the signed workflow, and no hosted macOS 13.0 runtime proves the oldest supported
OS. These are explicit proof limits, not reasons to weaken the product floor or signing gates.

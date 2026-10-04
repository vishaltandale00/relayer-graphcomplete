# First signed Windows candidate

Scope: independent Windows versions and manual signed artifacts. Windows VM acceptance, feed publication, update proof, and Stable promotion are outside this milestone.

## Product checkpoints and production seams

| Checkpoint | Changed seam | Deterministic checkpoint | Native evidence |
| --- | --- | --- | --- |
| Windows version reaches the installed application; macOS keeps its version | version loader, release contract, electron-builder extra metadata, packaged contract | `windows-candidate`: divergent versions through a real ASAR; numeric rejection | signed installer and sealed receipt |
| Windows release identity is independent | Preview provenance and pinned candidate-run resolver | `windows-candidate` and desktop-shell provenance scenarios reject wrong tags/workflows | immutable run/attempt/artifact ID/digest |
| Only reviewed main source can sign; candidates cannot publish | Windows workflow source/CI gates, permissions, environments, dependencies; Windows removed from macOS workflow | `windows-candidate`, `desktop-release-main-ci-check`, desktop-shell workflow checks | exact-source main CI plus manual signed run |
| Windows uses pinned static sources and complete notices | pinned preparation, archive validation, development/release Cargo entry points | Ladybug packaged lifecycle, packaging build cache, and source-build portfolios retain license and environment rejection | hosted MSVC locked/offline compilation and native receipt |
| Static OpenSSL carries its Windows system link dependencies | graph-server Cargo build script and shared OpenSSL link helper | `windows-candidate`: compile and execute the real build script for MSVC, non-MSVC, and Ladybug-disabled inputs; existing Rust archive-naming tests | hosted MSVC final link and packaged lifecycle |
| Windows checkout preserves canonical generated contracts | generated TypeScript checkout attributes and existing production drift checker | `windows-candidate`: real Git autocrlf checkout followed by production generator `--check` | detached Windows package preparation |
| Both Rust executables have x64 architecture and no external Ladybug/OpenSSL DLL dependency | extracted PE verifier and production afterPack | native file verification and desktop-shell packaged inventory scenario | afterPack verifies real executable bytes |
| Packaged Ladybug creates, locks, shuts down, and reopens | production Windows afterPack plus existing lifecycle capture | existing lifecycle scenarios | hosted unsigned qualification and fresh signed-package assembly |
| Exact publisher and timestamps cover application, Rust servers, installer | existing Windows signature verifier, configured Azure profile | existing Windows Authenticode rejection scenarios | actual signed candidate verification |
| Telemetry and release inventory use the platform version and exact source | existing telemetry upload and artifact sealing | telemetry release artifact and desktop-shell Windows NSIS scenarios | uploaded telemetry, checksums, release receipt |
| Shared macOS packaging remains valid | builder metadata, common pinned environment, afterPack imports | existing desktop and packaging portfolios | required macOS CI packaging lane |

## Verification plan

Run the focused release/native portfolios while editing. Before committing, run `npm run check` and `npm run build` with repository-pinned Node 22.23.2. The full deterministic portfolio is the fallback for any mapping gap. Existing Windows workflow assertions move to their new owner. The former Windows ambient Cargo environment expectation is superseded by pinned static compilation coverage; Windows assembly still preserves its tool environment, and Intel macOS passthrough remains covered. Windows development license rejection separately proves preparation and assembly cannot run without distribution authority.

PR Windows qualification requires the explicit `windows-qualification` label, uses read-only credentials, and cannot sign. After reviewed merge and exact-source main CI, run the manual candidate workflow. Record stage durations, failures, and the sealed installer identity. Existing native compilation caches authenticate macOS arm64 only; no compatible trusted Windows cache is available for the first qualification. Compile fresh; never treat a cache as acceptance evidence.

## Signing configuration verified 2026-10-04

Azure Public Trust profile `relayercodesigning/relayer-windows` is Active. GitHub's existing immutable environment-bound OIDC federation is unchanged. Its service principal now has only `Artifact Signing Certificate Profile Signer` on that profile. GitHub profile and exact publisher variables were configured. The Windows-inclusive authority audit passed. This audit proves configured GitHub release gates, not successful signing or VM acceptance.

The Windows environment now has the authorized Sentry credential. The CLI confirmed authentication and read access to releases in `relayer-labs-llc/graphcomplete-desktop`; actual Windows symbol upload remains due in the signed candidate run.

## Results

Local verification on 2026-10-04 used Node 22.23.2 and an isolated Cargo target directory. No compatible verified check-profile cache was available; native checks compiled from source. `npm run check` passed, including Rust format/clippy/tests/crash reconciliation, 3,450 source Vitest tests (3 skipped), the 2-test secret-boundary portfolio, 68 Python tests, receipt lints, and PRD readability. `npm run build` passed. The packaging build-cache portfolio was rerun after adding the Windows development license-refusal checkpoint: 9/9 passed in 368 ms.

The first full check failed because integration fixtures expected checkout-local `target/debug` binaries while the isolated build directory was elsewhere, and an existing Windows development test still expected ambient Cargo inputs. An ignored `target` link exposes the freshly built isolated binaries to those fixtures; the obsolete expectation was replaced as described above. The corrected full check passed. Logs are `/private/tmp/windows-full-check-2.log`, `/private/tmp/windows-full-build.log`, and `/private/tmp/windows-packaging-check.log`; these local logs are not hosted release evidence.

PR #663 required CI run `37233676805` passed, including macOS package inspection, in 6 minutes 44 seconds while the separate Windows qualification was still running. This observes independent completion, not a statistical latency or reliability guarantee.

First Windows qualification run `37233676775` passed pinned native source/static OpenSSL preparation, then failed before Cargo compilation: Windows Git converted `packages/graph-client/src/query-errors.generated.ts` to CRLF, so the exact production generated-contract checker rejected it as stale. A real Git autocrlf regression scenario reproduced that failure locally. The fix pins that generated file to LF, preserving strict drift checking. The duplicate pending label-event run was canceled because the opened-event run already qualified the same source.

The checkout fix passed the focused native/candidate portfolio (39 tests). Expanding the `.gitattributes` checkpoint mapping initially failed the planner's old expected-list assertion; the strict expected list was updated to include the new production checkout checkpoint. The planner/candidate portfolio then passed (82 tests). Final `npm run check` passed with 3,452 source Vitest tests (3 skipped), secret-boundary/Python/Rust checks and lints; `npm run build` passed. Latest local logs are `/private/tmp/windows-full-check-4.log` and `/private/tmp/windows-full-build-2.log`. Hosted qualification of the correction remains due.

Hosted Windows qualification and actual signing are pending. No signed installer, VM acceptance, Windows publication, or Stable proof is claimed yet. Windows tags remain reserved until the later protected publication change. Shared GitHub runner queue latency and Windows reliability still need observed runs.

The corrected checkout passed required CI run `37235759922`, including macOS package inspection, in 6 minutes 30 seconds. Windows qualification run `37235759872` checked out exact merge source `ae728ca63e9f64d023cbf3599cb4cd73eaa7dab2`, cleared generated-contract validation, and compiled Ladybug from its pinned source. It failed at final graph-server linking after 54 minutes 42 seconds: static OpenSSL referenced `GetProcessWindowStation`, `GetUserObjectInformationW`, and `MessageBoxW`, but Cargo omitted `user32.lib`. No package lifecycle or installer proof was produced.

The real Cargo build-script regression reproduced the missing Windows library directives locally in 1.6 seconds. The correction adds the five system dependencies declared by [OpenSSL 3.5.8's Windows configuration](https://github.com/openssl/openssl/blob/openssl-3.5.8/Configurations/10-main.conf#L1542-L1546) only for static MSVC linkage. Both the build script and its included helper are now authenticated receipt inputs with LF checkout bytes. Non-MSVC static archive directives and Ladybug-disabled behavior are checked through the same executable. These directive checks are not native-link proof; hosted Windows qualification remains due on the corrected source. Existing Rust naming tests retain the separate dynamic-link boundary. No unchanged failure retry has been used.

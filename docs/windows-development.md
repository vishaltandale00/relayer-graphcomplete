# Windows development and first-install gate

The Windows installer is the tester-distribution gate. A working modified Dev
folder or an installer signature does not satisfy it. Windows versioning and
candidate packaging remain independent of macOS and the main E2E pipeline.
This procedure does not publish Preview or promote Stable.

## Self-contained application

Windows packages include the official Node 22.23.2 x64 executable, its complete
LICENSE and fixed provenance under `resources/node`. Preparation authenticates
the official ZIP, executable and license hashes before copying. The directory
copy allows the existing Azure signing transformer to sign the packaged Node
without changing the vendor cache. Final Relayer signature verification includes
Node, Electron and both Rust services.

Both native authoring harnesses receive the absolute app-owned Node path. Codex
uses PowerShell's call operator and UTF-8 single-quoted stdin; Claude uses Bash.
The macOS restricted zero-argument launcher remains a separate authority path.
No graph-authoring runtime is taken from inherited environment or PATH, and the
new executable dependency grants no sandbox escalation.

The initialized MSVC toolchain supplies its x64 redistribution DLLs. Preparation
requires valid Microsoft signatures and x64 PE identity; copying preserves those
signatures and hashes. The DLLs live alongside the Rust services. Package
verification checks their import closure, hashes, Node version, and loading the
real packaged graph client with ambient PATH empty. Actual loaded DLL origins
are a separate first-install checkpoint, because an SDK-equipped VM can mask a
missing dependency. This uses Microsoft's documented application-local deployment:
<https://learn.microsoft.com/en-us/cpp/windows/choosing-a-deployment-method?view=msvc-170>.

## Repeatable existing-VM command

The existing private Windows 11 VM has Node 22.23.2, Rust, Git, native Strawberry Perl, CMake and VS2022
Build Tools in `RelayerDevWorkspace` and `C:\RelayerBuildTools2022`. The versioned
`windows-dev-environment.cmd` initializes only the build subprocess environment.
The source archive currently starts at `3c641e1c2fbb58e4973475819a5c5c93dddd79c0`.
From the Mac checkout:

```sh
# Inspect size, changed paths and hashes; no transfer or build.
npm run desktop:sync:windows -- --base 3c641e1c2fbb58e4973475819a5c5c93dddd79c0 --plan
# First native build, after inspecting compatible trusted caches.
npm run desktop:sync:windows -- --base 3c641e1c2fbb58e4973475819a5c5c93dddd79c0 --rust --allow-cold
# Observe the lease, last result and active compiler processes.
npm run desktop:status:windows
# Reconcile only after a lost transfer acknowledgement; verifies remote bytes.
npm run desktop:sync:windows -- --reconcile-sync <sync-id>
# Resume an acknowledged sync only if its build wrapper never claimed it.
npm run desktop:sync:windows -- --resume-sync <sync-id> --rust --allow-cold
# Later Rust edits retain the native prefix and Cargo objects.
npm run desktop:sync:windows -- --base 3c641e1c2fbb58e4973475819a5c5c93dddd79c0 --rust
# JS-only edits reject changed Rust inputs and reuse checked native outputs.
npm run desktop:sync:windows -- --base 3c641e1c2fbb58e4973475819a5c5c93dddd79c0
```

The command uses the existing Azure CLI login and VM; it creates no cloud
resources. It excludes credentials, dotenv files, .git, dependencies, native
outputs and application data. All remote old hashes are checked before writes.
Directory symlinks, duplicate/case-alias paths, unmanaged deletions and changed
remote source are rejected. Changed files have rollback copies. The Mac retains
an acknowledged per-file state so subsequent transfers contain deltas. Stage new source
files with `git add` before syncing; arbitrary untracked files are never uploaded.
A Mac lock serializes sync-state writes; a VM lease holds the source and build
outputs exclusively through dependency installation, packaging and the final receipt. Deltas
above 4 MiB require artifact staging instead of unlimited Run Command payloads.
Dependency installation has its own success marker bound to the lockfile and Node
version. Failed setup is retried even when the source delta is unchanged.

Native preparation and Cargo outputs use the fixed short `C:\RelayerDev` prefix,
avoiding path-length failures and source-directory moves. Cache identity binds
actual compiler/tool hashes, Rust versions, SDK and MSVC environment, native
source manifest and preparation implementation. Native Windows Perl/IPC::Cmd is preflighted before preparation; Git MSYS Perl is
rejected. The independent Windows candidate jobs verify Node/CRT inputs before
long compilation. Every hit rechecks the pinned
Ladybug tree and static OpenSSL inputs. The Cargo build uses locked/offline inputs
and incremental release compilation. These local Dev outputs cannot be adopted
by the protected release workflow. A no-op Cargo hit does not establish the cost
of a Rust edit: measure a real changed-source rebuild separately.

Receipts under `.relayer/windows-dev-sync` record source/transfer identity;
`C:\RelayerDev\loops.jsonl` records build stages, failures and the measured
bottleneck. Dispatch requires the build wrapper to acknowledge its lease; it is still not build completion. Status preserves setup failures as well as build receipts. An unclaimed sync-ready lease can be resumed explicitly with the same sync ID after fixing its driver; stale building leases require inspecting the owner process, never automatic removal. Compare transfer,
preparation, Cargo, JS and packaging seconds after each loop. Preserve failures;
do not retry an unchanged failure until its cause is diagnosed. JavaScript
compilation currently happens in the VM; moving that stage to the Mac is a later
optimization if measurements justify it.

## First-install qualification

Use a fresh ordinary Windows user with no pre-existing Relayer installation or
application data. Keep the compiler user's workspace separate. Do not remove
another user's application data. Preserve the immutable successful candidate
run/attempt, artifact ID/ZIP hash, sealed release receipt and installer hash.

1. Run `desktop/release/inspect-windows-first-install.ps1 -Phase prepare` with
   explicit installer, release receipt, intended installed executable, fresh user
   data and evidence directory. It checks the exact installer hash and sealed
   publisher signature, and rejects an existing install/profile.
2. Install through the normal interactive installer as the fresh ordinary user.
   Launch normally with external Node absent from PATH and development overrides
   cleared. Record the real installed path and packaged version/source metadata.
3. Run the inspection script with `-Phase installed`. It verifies all five
   Relayer-signed files and compares installed application files byte-for-byte
   against the exact NSIS installer payload using the locked `7zip-bin` tool, exercises the bundled Node with Unicode stdin, and records
   the DLL paths actually loaded by the running Rust services. System VC-runtime
   origins fail the gate.
4. Connect the live provider; complete `Why the sky is blue?`; inspect the graph
   and navigation. Collect the exact completion state using the installed Node:
   `node.exe desktop/release/collect-windows-install-state.mjs <graph.sqlite3> <interaction-id> <new-output.json>`.
   Collect sanitized proof from the actual native Codex rollout in this fresh profile:
   `node.exe desktop/release/collect-windows-authoring-runtime.mjs <rollout.jsonl> <fresh-user-data> <installed-Relayer.exe> <interaction-id> <runtime-observation-timestamp> <new-authoring.json>`.
   This checks the successful app-owned Node invocation and retains hashes, paths and call IDs only. The operator maps the chosen rollout to the live interaction; the gate binds that ID, fresh profile, installed Node path and chronology.
   Save screenshots/video and the sanitized authoring-runtime record; do not copy
   credentials, raw provider rollouts or private application databases.
5. Close cleanly, launch the installed shortcut, reopen the same persisted graph,
   and complete a follow-up. Save a separate reopen record for the original completion and another exact
   state record for the accepted follow-up, plus UI evidence.
6. Assemble `windows-first-install-observations/v1` from those actual records and
   operator UI observations. Run `npm run desktop:qualify:windows-install --
   <release-receipt> <installer> <observations> <new-gate-output>`. Missing source,
   environment, signatures, runtime, live acceptance, reopen or retained evidence
   withholds the gate. The command rehashes evidence files and refuses to overwrite
   an existing gate result.

A `windows-first-install/v1` PASS qualifies only those exact installer bytes and
observations. It is not an updater canary, Preview publication, Stable promotion,
or coverage of every provider/model. The existing published-feed upgrade canary
remains separate and required before Stable.

## Changed seams and verification

PRD 14.2/14.3 promise a usable packaged application; 14.5 requires clean install,
provider setup, graph behavior and reopen proof. AGT-007 owns provider credential
isolation. No graph lifecycle or provider recursion policy is changed.

| Seam / boundary | Small deterministic checkpoint | Required platform evidence |
| --- | --- | --- |
| Dev share endpoint startup | `share-service-endpoint.test.mjs`: valid Dev identity only, release policy unchanged | Ordinary packaged startup |
| Official Node preparation | `windows-app-runtime.test.mjs`: pinned archive rejection before extraction, corrupt cache and symlink rejection | Official verified preparation and packaged version/client probe |
| Resource copy and signing | Existing builder-copy scenario plus Windows-only runtime inventory | Actual Node Azure signature and untouched vendor input; Microsoft DLL provenance |
| Codex/Claude authoring dependency | Both native harness tests, command Unicode/interpolation tests | Exact native PowerShell Unicode stdin and live app-owned command |
| Provider PATH/private trace | Codex environment and private-presentation trace tests | No external Node and no credential expansion |
| Desktop factory composition | Harness runtime integration and required `npm run check` fallback | Installed app invokes the owned runtime |
| Local Rust cache and outputs | Dev input change/symlink tests; flags/platform rejection | Cold and changed-source warm timings, verified native preparation |
| Source delta mutation | Real subprocess delta, old-hash rejection, backup and parent-symlink escape tests | Acknowledged VM delta and source digest |
| Installer evidence authority | First-install validator rejects missing or mismatched source/runtime/acceptance/reopen/evidence | Actual signed installation, DLL origins, accepted graph, clean shutdown and reopen |
| Sealed evidence files | Evidence hashes rechecked, output written once | Retained screenshots/video/runtime/persistence hashes |

Before commit run the relevant focused tests, `npm run check` and `npm run build`.
Before declaring the installer gate passed run the declared Windows package and
first-install scenarios. Document the exact tested source and adversarial review;
planned checks and dispatch acknowledgements are not proof.

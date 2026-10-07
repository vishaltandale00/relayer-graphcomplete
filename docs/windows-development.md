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

The existing private Windows 11 VM has Node 22.23.2, Rust, Git, native Strawberry Perl, Python 3.13.12, CMake and VS2022
Build Tools in `RelayerDevWorkspace` and `C:\RelayerBuildTools2022`. The portable Perl archive includes CMake 3.29 and its module tree; retain both when extracting it. The versioned
`windows-dev-environment.cmd` initializes only the build subprocess environment and preflights the selected CMake module tree, Ninja and Python before dispatching compilation.
Python's official x64 embeddable ZIP is pinned to SHA-256
`76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0`
([publisher release](https://www.python.org/downloads/release/python-31312/)).
It belongs only to the build workspace, not the installed app. The entire Python
runtime, ccache executable, selected CMake executable and its actual CMAKE_ROOT
module/runtime tree participate in compiled-native identity. CMake metadata
probes use temporary scratch outside the audited source tree. A changed
generator invalidates Ladybug outputs while retaining independently verified
source/static OpenSSL preparation. A separate attempted-compiler identity is
recorded before Cargo, so failures after Ladybug finishes cannot admit stale
objects on a later generator change. Non-reuse transitions remove the previous
success record before Cargo cleanup; a failed cleanup leaves no JS-only success
and the next attempt repeats required cleanup. JS-only packaging requires matching
attempt/success identities and rehashes both fixed-target native executables.
An inherited conflicting Rust target is rejected. Compiler/SDK or producer changes invalidate
the whole Cargo target; generator-only changes invalidate Ladybug. Unknown old
Cargo workspaces start with invalidation, while verified preparation remains.
Ambient ccache overrides are rejected, and
this Dev route disables its object cache so Cargo/Ninja own incremental reuse.
The source archive currently starts at `3c641e1c2fbb58e4973475819a5c5c93dddd79c0`.
From the Mac checkout:

```sh
# Inspect size, changed paths and hashes; no transfer or build.
npm run desktop:sync:windows -- --base 3c641e1c2fbb58e4973475819a5c5c93dddd79c0 --plan
# First native build, after inspecting compatible trusted caches.
npm run desktop:sync:windows -- --base 3c641e1c2fbb58e4973475819a5c5c93dddd79c0 --rust --allow-cold
# Migrate an existing partial-state workspace: audit all base/acknowledged bytes,
# then apply current deltas; retain Cargo objects and verified preparation.
npm run desktop:sync:windows -- --base 3c641e1c2fbb58e4973475819a5c5c93dddd79c0 --audit-source --sync-only
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
outputs and application data. Version 2 audits the complete trusted tracked
manifest, including unchanged Git-base files, before writes. Its before-state
contains every acknowledged prior byte and absent new path; its current state
contains every tracked file and deletion. Credential-handling source modules
remain included; credential data and dotenv files are excluded. Directory
symlinks, duplicate/case-alias paths, unmanaged deletions and changed remote
source are rejected. A source-tree inventory also rejects unreviewed extra files
that packaging globs or module loading could consume. The explicit exceptions
are the fixed root dependency/generated directories (`node_modules`, `target`,
`dist`, `.relayer`, coverage), desktop outputs, the four known package output
roots and named renderer/agent-resource output directories, root-only local
logs/dotenv data and PRD annotations. Credential-shaped files or logs inside
the desktop/native source tree receive no exception. Arbitrary source subdirectories named `dist`, `target`
or `node_modules` receive no exception. Tracked files
always remain audited inside those paths; arbitrary ignored source files do not
gain an exception from `.gitignore`. Generated outputs remain governed by locked
dependency preparation and package qualification. Changed files and the previous source-state record have
rollback copies. The Mac retains the complete acknowledged manifest while
subsequent transfers contain only changed file contents plus compressed hashes. Stage new source
files with `git add` before syncing; arbitrary untracked files are never uploaded.
A Mac lock serializes sync-state writes; a VM lease holds the source and build
outputs exclusively through dependency installation, packaging and the final receipt. Deltas
above 4 MiB require artifact staging instead of unlimited Run Command payloads.
Dependency installation has a v2 success marker bound to the lockfile, Node
version, platform/architecture and the actual installed dependency inventory.
Every reuse hashes installed files with bounded workers and checks directory/link
identity, including nested dependency roots from the lockfile. Workspace links
must match their locked source targets; generated workspace outputs are rebuilt
separately. Missing, changed, unsafe or legacy dependency state runs locked
`npm ci --ignore-scripts`; the marker is removed before restoration and sealed
only after successful installation and inventory. Failed setup is retried even
when the source delta is unchanged.

Legacy partial manifests fail closed. After the active build finishes, use the
explicit `--audit-source --sync-only` command above with the original VM base.
It overlays the old acknowledged deltas onto the trusted Git baseline, audits
every remote byte before applying current Mac deltas, and retains the old Mac
state plus the remote prior record. Hidden unchanged-file mismatches stop before
writes and name the path; inspect and restore only that source from its known
commit/receipt, then audit again. Do not discard the Cargo target or native cache.
Old partial plans cannot be resumed or reconciled as qualified source. Once the
v2 audit is acknowledged, a normal `--rust` loop preserves its compiler identity.

Dispatch and resume independently audit the full current manifest before
executing the remote driver. Reconciliation rechecks that same complete retained
identity before advancing Mac state. The Windows wrapper requires the acknowledged `--sync-id` and v2 state. It
binds that state to the full digest and baseline identity retained in its source
lease, then checks all tracked bytes before dependencies and again after
packaging. A standalone invocation without an acknowledged sync fails closed. The source digest identifies the complete tracked
manifest, not merely the transferred paths. Untracked files are never uploaded.

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

Use a fresh ordinary Windows user with no pre-existing production Relayer installation or
application data. Run the inspection in that user's session; administrator-group
members and service identities, including Azure Run Command SYSTEM, fail qualification.
Keep the compiler user's workspace separate. Do not remove
another user's application data. Preserve the immutable successful candidate
run/attempt, artifact ID/ZIP hash, sealed release receipt and installer hash.

1. Run `desktop/release/inspect-windows-first-install.ps1 -Phase prepare` with
   explicit installer, release receipt, intended installed executable, fresh user
   data and evidence directory. It checks the exact installer hash and sealed
   publisher signature, and records the actual Windows SID/profile. The entire intended
   application directory and user-data directory must be absent, not only Relayer.exe.
   It also checks default per-user/machine production directories and the pinned
   NSIS install/uninstall keys in both HKCU/HKLM registry views, including legacy
   production uninstall display names. Existing directories or registrations fail
   first-install qualification; do not erase them to make the check pass.
2. Install through the normal interactive installer as the fresh ordinary user.
   Launch normally with external Node absent from PATH and development overrides
   cleared. Record the real installed path and packaged version/source metadata.
3. Run the inspection script with `-Phase installed`. It verifies all five
   Relayer-signed files and compares installed application files byte-for-byte
   against the exact NSIS installer payload using the pinned electron-builder 7zip toolset.
   The payload inventory records its canonical installed root and must match the
   launched executable. The script also requires the expected per-user HKCU
   64-bit NSIS install/uninstall registrations, exact version and uninstaller,
   while rejecting unexpected machine/legacy registration. The locked one-click
   default is `%LOCALAPPDATA%\Programs\relayer-desktop`. It exercises the bundled Node with Unicode stdin and records
   the DLL paths actually loaded by the running Rust services. The recorded identity
   must match the prepare SID and profile. System VC-runtime
   origins fail the gate.
4. Connect the live provider; complete `Why the sky is blue?`; inspect the graph
   and navigation. Collect the exact completion state using the installed Node:
   `node.exe desktop/release/collect-windows-install-state.mjs <installed-runtime.json> <interaction-id> <new-output.json>`.
   The v2 record reads both actual production databases, joins the latest accepted
   execution attempt and binds the exact prompt, provider, model, node and thread.
   Operator labels do not establish live-provider use. It samples actual ordinary-user
   Electron/Rust process IDs, creation times, image hashes and parentage before
   and after the database read; a changing generation rejects collection.
   Collect sanitized proof from the actual native Codex rollout:
   `node.exe collect-windows-authoring-runtime.mjs <rollout.jsonl> <installed.json> <observed-interaction-id> <observed-final-layer-id> <runtime-observation-timestamp> <new-authoring.json>`.
   Use the installed bundled Node to run this helper. It derives identity and paths from
   the real installed inspection, then derives the interaction and final layer from
   the successful `graph.submit` API result. CLI IDs are expectations, never labels
   copied onto a generic Node probe. It retains hashes, paths, SID and call IDs only.
   Normal API-provider Codex sessions can live in the QA user's `.codex/sessions`;
   managed subscription/provider homes can live under Relayer app data. The helper
   recognizes these existing routes, binds them to the measured QA SID/profile and
   installed runtime receipt, and rejects another user's or an unsupported home.
   Do not set a development `CODEX_HOME` override merely to obtain proof.
   Save screenshots/video and the sanitized authoring-runtime record; do not copy
   credentials, raw provider rollouts or private application databases.
5. Close cleanly and collect the separate `shutdown-processes` evidence with
   `node.exe collect-windows-install-state.mjs <installed-runtime.json> --stopped <new-shutdown.json>`.
   It requires zero candidate processes. Then launch the installed shortcut,
   reopen the same persisted graph and complete a follow-up. Reopen must have
   newly created Electron/Rust processes after that stopped checkpoint; follow-up
   must retain the reopened generation and thread. Save a separate reopen record for the original completion and another exact
   state record for the accepted follow-up, plus UI evidence.
6. Assemble `windows-first-install-observations/v1` from those actual records and
   operator UI observations. Run `npm run desktop:qualify:windows-install --
   <release-receipt> <installer> <observations> <new-gate-output>`. Missing source,
   environment, signatures, runtime, live acceptance, reopen or retained evidence
   withholds the gate. The command rehashes evidence files and refuses to overwrite
   an existing gate result.

### Qualification helper staging and native submission proof

Stage qualification helpers from the exact reviewed checkout after its locked
`npm ci`. They are QA tooling; TypeScript is not added to the application.
The authoring collector parses JavaScript without evaluating it and requires
TypeScript **5.9.3**, authenticated by the existing lockfile integrity:
`sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==`.
Copy these release helpers into the ordinary user's QA tools directory:
`inspect-windows-first-install.ps1`, `read-windows-install-metadata.mjs`,
`collect-windows-installer-files.mjs`, `collect-windows-install-state.mjs`,
`collect-windows-install-processes.ps1`, and `collect-windows-authoring-runtime.mjs`. Alongside them, stage the unchanged
locked `node_modules/typescript/package.json`, `lib/typescript.js`, `LICENSE.txt`
and `ThirdPartyNoticeText.txt`, retaining the same package directory structure.
Retain their SHA-256 file inventory with the helper/source receipt. For example,
from the already authenticated checkout:

```powershell
$qaTools=Join-Path $env:USERPROFILE 'RelayerQualificationTools'
$ts=Join-Path $qaTools 'node_modules\typescript'
New-Item -ItemType Directory -Path (Join-Path $ts 'lib') -Force | Out-Null
foreach($name in @('package.json','LICENSE.txt','ThirdPartyNoticeText.txt')) {
  Copy-Item -LiteralPath (Join-Path $checkout ('node_modules\typescript\'+$name)) -Destination $ts
}
Copy-Item -LiteralPath (Join-Path $checkout 'node_modules\typescript\lib\typescript.js') -Destination (Join-Path $ts 'lib')
```

The remaining installed-app checks run with `resources/node/node.exe`; they need
no external Node installation or compiler PATH. Missing/wrong parser inputs stop
collection. The pinned electron-builder 26.15.3 toolset remains required for installer payload comparison. Resolve its `app-builder-lib/out/toolsets/7zip.js` `getPath7za()` with `ELECTRON_BUILDER_7ZIP_PATH` unset. The Windows x64 `7zip@1.0.0` archive is authenticated against SHA-256 `be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3`; retain the resolved executable hash with the helper inventory.

Keep the question exactly `Why the sky is blue?`; provide proof-specific guidance
through the separate normal supported request context. Author the graph drafts using earlier commands, then run a separate minimal final
submission through the exact installed app-owned Node. The qualifying JavaScript
contains only the displayed installed graph-client import, `const graph =
RelayerGraphClient.fromEnv()`, an awaited `graph.submit` with the **actual positive
literal interaction ID**, and JSON printing of that returned API object. Example
shape (replace the path and `123` with the real prompt's values):

```javascript
import { RelayerGraphClient } from 'file:///C:/actual-installed-app/resources/graph-client/index.js';
const graph = RelayerGraphClient.fromEnv();
const result = await graph.submit(123);
console.log(JSON.stringify(result));
```

Pipe that program using the native single-quoted PowerShell here-string to the
exact single-quoted `resources/node/node.exe --input-type=module` command, doubling
apostrophes in its literal path. The entire PowerShell command contains only that
pipeline, optionally preceded by fixed `$OutputEncoding` and
`[Console]::OutputEncoding` UTF-8 assignments; surrounding or trailing commands
cannot qualify. The parser accepts this small final-submit grammar; extra mutation/authoring statements, probes,
caller-fabricated result objects and generic success text cannot qualify. This
changes the qualification guidance, not the application's recursion or scheduler.

For a native custom `exec` wrapper, preserve the complete inner command result:
use exactly `const r = await tools.exec_command({cmd: <static literal command>,
shell: "powershell", max_output_tokens: 20000, yield_time_ms: 30000}); text(r);`.
A static literal includes an ordinary quoted string or a template without
interpolation. The paired native output must retain `exit_code: 0` and its complete
stdout JSON API result. `text(r.output)` discards the inner exit status and fails
the gate even when the outer script says completed. Direct native function-call
output must similarly retain its single successful status header and final stdout.
Both formats must return the actual accepted completion's node/root-layer IDs,
which are matched to the observed persisted graph. Earlier Dev videos or truncated,
status-discarding rollouts remain non-certifying; rerun the real installed scenario.

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
| Windows C++ debug information and cache authority | `ladybug-source-build.test.mjs` checks the owned Windows-only environment; `windows-native-cache.test.mjs` rejects unreviewed toolchain bytes and invalidates admitted changes; packaged receipt/LF checks include the toolchain | `node scripts/check-windows-rust-symbols.mjs` compiles C/C++ with Ladybug's CMake 3.15 policy floor and requires `/Z7` without `/Zi` before long builds; linked EXE/PDB verification and packaged lifecycle remain required |
| Local Rust cache and outputs | Dev input change/symlink tests; flags/platform rejection | Cold and changed-source warm timings, verified native preparation |
| Complete tracked-source identity and delta mutation | Real Git-baseline/subprocess fixtures cover unchanged-file tampering, extra unreviewed source, deletion, local/remote parent symlinks, explicit partial-state migration, retained rollback, recovery and lease-bound wrapper verification | Actual full-baseline VM audit, acknowledged v2 source digest, then changed-source warm build |
| Optional Git folder inspection and project Send | `worktree-service.test.mjs` and Rust `missing_git_admits_plain_folder_send_but_not_repository_markers`: isolated missing-Git processes permit unmarked ordinary folders through project/thread creation; marked, nested and linked paths retain inspection errors | Normal folder picker and successful Send with no Git on PATH in the exact signed installation |
| Exact installer payload extraction | `windows-first-install.test.mjs`: complete nested and direct extraction layouts compare all installed files; partial, mixed, multiple and tampered payloads reject | Pinned 7za extracts the exact sealed installer; installed inventory hashes and source match |
| Installer evidence authority | First-install validator rejects missing or mismatched source/runtime/acceptance/reopen/evidence | Actual signed installation, DLL origins, accepted graph, clean shutdown and reopen |
| Persisted product acceptance | `windows-first-install.test.mjs`: migrated SQLite and sealed-record fixtures require product `accepted`, latest attempt `accepted`, and graph lifecycle `succeeded`; pending, stopped, failed and invented product `succeeded` reject | Actual installed product and graph records joined by the observed interaction node |
| Sealed evidence files | Evidence hashes rechecked, output written once | Retained screenshots/video/runtime/persistence hashes |

Before commit run the relevant focused tests, `npm run check` and `npm run build`.
Before declaring the installer gate passed run the declared Windows package and
first-install scenarios. Document the exact tested source and adversarial review;
planned checks and dispatch acknowledgements are not proof.

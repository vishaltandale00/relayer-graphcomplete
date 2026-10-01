# ADR 0003: Eval reviews use the production product workspace

Status: accepted

## Decision

Relayer Eval is a developer-only local web application launched from a checkout, with a distinct data profile, but it does not own a second graph or chat experience. Each test-case × harness execution creates ordinary projects, threads, interactions, and accepted graph output through the Relayer product app server. Opening an execution serves the production renderer with a server-enforced read-only session capability and review-mode controls.

The Eval-only surface owns test-run concerns: case selection, harness-configuration selection, judge selection, execution status, scores, and aggregate results. The review page owns product concerns: turn navigation, graph layout, layer navigation, node selection, and node details. Its left sidebar is supplied with the selected run's cases and their product threads for one fixed harness configuration; it is not a comparison view.

The public Relayer build remains an Electron application. Eval has a Node entry point, its own data directory and dashboard assets, and no desktop package. Harness overrides and test catalogs are exposed only by the Eval entry point. Both hosts supervise the same Rust graph server, Node harness host, Rust product app server, and production renderer contract.

## Consequences

- Product graph/chat improvements automatically appear in evaluation review pages.
- An eval result is product state with additional evaluation metadata, not an HTML replay or translated graph shape.
- Eval persistence may reference product thread IDs, but judges must persist their own immutable checks and configuration snapshots.
- Completed review pages receive a read-only app-server session and are read-only except for turn, layer, case, thread, and node-detail navigation.
- Public product APIs reject caller-selected harness overrides; the Eval app server explicitly enables them.
- The standalone runtime runner and its HTML viewer are retired. Historical artifacts remain evidence of their original runs; current evaluation execution and review use Relayer Eval.

## Hosting decision (2026-09-26)

Eval users have a developer checkout. `npm run eval-app:dev` starts the local host
and prints an authenticated loopback URL. The terminal owns service lifetime;
closing a tab leaves execution running, and Ctrl-C stops owned services. The
checkout pins dependencies. Eval has no installer, updater, or Electron package.

The dashboard and each human review use separate origins and opaque browser
capabilities. Authenticated URLs retain their opaque fragment for transfer between
local browsers. Reload restores a stripped fragment from that tab’s session storage;
a bare URL never receives authority from the server. Rust credentials remain server-side. Human review forwards only
read-only authority and its thread-scoped annotation credential. Automated judges
use fresh pinned Chromium contexts with read-only credentials; their input
operator authority stays in the backend. Review capture and production-workspace
behavior remain required. Browser Eval does not certify Electron-specific behavior.

Prime development credentials may be loaded from an explicitly selected profile.
The full provider-setup decision below imports them into the secure Eval store.
Existing Electron profiles and shared native logins are not automatically adopted.

This replaces the original separate internal Electron distribution decision.
Keeping Electron would preserve an installation workflow that developers do not
need. A remotely hosted, multi-user evaluation service remains outside this decision.

## Development loop (2026-09-27)

Eval launch uses the checkout's existing shared runtime artifacts without invoking
build or packaging commands. Developers rebuild changed Rust or TypeScript inputs
explicitly; dashboard, renderer, and host JavaScript edits need no Eval build.
Packaged-Eval configuration, credential, autorun, and startup-maintenance branches
are removed. Existing review authority and browser proof remain unchanged.

Developers run the existing `npm run build` after compiled-source or dependency
changes, including the root Complete output, and restart Eval. Eval does not add
a preparation command, artifact-ownership policy, or freshness detector. Private
Cargo outputs are verification setup, not an Eval startup guarantee. This keeps
the manual development loop without the proposed preparation machinery in #501.


## Human task execution (issue #544)

Eval Settings reuses the production provider composition, adapter registry, runtime
readiness, and Providers/Model families/Harnesses renderer components. It opens on
an independent settings capability that forwards only allowlisted model operations
and provider lifecycle methods. Human task and review capabilities cannot acquire
this authority. Provider and model changes reject active sessions and runs.

Native authentication, discovery, execution, and judges use profile-scoped homes
and an allowlisted environment, never shared machine login state. API keys on macOS
use the production encrypted credential store with an AES-GCM key in macOS Keychain;
unsupported platforms fail explicitly rather than persist plaintext. Credentials
never enter response payloads or evidence exports. Startup, settings, and Send do
not install runtimes; explicit connect/reconnect/refresh may prepare them. The
optional Prime development profile is imported into this same composition.

Human Grader additionally admits a live human task mode, separate from saved
review. It uses the production renderer and ordinary product APIs, with a
backend-held credential and a per-session gateway allowlist for its owned case
threads. Rust credentials never enter the browser. The gateway serializes
completion admission, enforces the configured budget, and stops admitting writes
when the session ends or a dispatch outcome is unknown. It exposes no general
thread creation, internal API, or settings authority.

People act between settled responses. Case project preparation and each thread's
permission profile remain shared with ordinary Eval. Recorded experience,
satisfaction, and termination do not replace product acceptance or deterministic
outcome checks. Finish freezes the conversations; review uses the existing
read-only surface and scoped graph annotations. Ordered moment annotations and
exports belong to Eval evidence. Existing in-turn simulated-user work remains a
separate mode, and this decision does not relax its Send restrictions.

## Settings return navigation

Settings offers Back to Eval instead of relying on window.close. The originating
dashboard adds its authenticated return URL to the settings fragment. The bridge
preserves this explicit navigation context across reloads and copied links, and
accepts only loopback root destinations with a valid capability fragment. The
settings gateway does not mint or disclose dashboard credentials. Older links
without return context display recovery instructions instead of silently failing.

Dashboard-opened Settings links intentionally carry both browser capabilities
for same-user navigation. They must be treated as authenticated dashboard links,
not as Settings-only delegation links. Rust credentials remain server-side.

## Simulated task users (issue #544, slice 2)

A separate Eval actor drives the production live-task surface between settled
responses. It reuses HumanTaskService admission and recording. It observes
viewport screenshots and current enabled controls, not raw graph records, task
files, or judge topology. A dedicated native Codex thread has no shell, search,
filesystem tools, or MCP servers. This user interaction loop does not schedule
GraphComplete agents or change provider-owned recursion.

The actor capability projects only task display context, disables annotations,
and rejects grading operations. Humans watch and grade through a separate
read-only review capability. Actor satisfaction is distinct from human grades.
Cancellation, deadlines, action limits and host interruption preserve evidence
without implicit replay or inferred task success.

### Live actor calibration follow-up

After the first live run, the user approved using the existing private user brief
for actor consistency. Only the actor receives that brief; the candidate still
receives ordinary task prompts and user actions. Rubrics and human feedback
remain unavailable to the actor. Version 2 favors short immediate replies,
consistent preferences and explicit uncertainty. It records endpoint status and
remaining work independently of satisfaction. Action-specific human annotations
support manual tuning, not automatic policy changes. The actor default is
GPT-5.6 Luna, with model/effort catalog preflight before candidate inference.

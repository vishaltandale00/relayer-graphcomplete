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
capabilities. Rust credentials remain server-side. Human review forwards only
read-only authority and its thread-scoped annotation credential. Automated judges
use fresh pinned Chromium contexts with read-only credentials; their input
operator authority stays in the backend. Review capture and production-workspace
behavior remain required. Browser Eval does not certify Electron-specific behavior.

Prime development credentials are loaded from the explicitly selected profile
on each launch and retained only in memory by the Eval host. No OS encryption
replacement or new on-disk secret store is introduced. Existing Electron profiles
are not automatically adopted; users may explicitly select a compatible data
profile, with its native credential file left untouched.

This replaces the original separate internal Electron distribution decision.
Keeping Electron would preserve an installation workflow that developers do not
need. A remotely hosted, multi-user evaluation service remains outside this decision.

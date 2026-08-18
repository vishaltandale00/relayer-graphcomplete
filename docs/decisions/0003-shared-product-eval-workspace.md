# ADR 0003: Eval reviews use the production product workspace

Status: accepted

## Decision

Relayer Eval is a distinct internal Electron application and data profile, but it does not own a second graph or chat experience. Each test-case × harness execution creates ordinary projects, threads, interactions, and accepted graph output through the Relayer product app server. Opening an execution launches the production renderer in read-only review mode.

The Eval-only surface owns test-run concerns: case selection, harness-configuration selection, judge selection, execution status, scores, and aggregate results. The review window owns product concerns: turn navigation, graph layout, layer navigation, node selection, and node details. Its left sidebar is supplied with the selected run's cases and their product threads for one fixed harness configuration; it is not a comparison view.

The public Relayer build and internal Relayer Eval build have different application identifiers, entry points, data directories, and renderer assets. Harness overrides and test catalogs are exposed only by the Eval entry point. Both builds supervise the same Rust graph server, Node harness host, Rust product app server, and production renderer contract.

## Consequences

- Product graph/chat improvements automatically appear in evaluation review windows.
- An eval result is product state with additional evaluation metadata, not an HTML replay or translated graph shape.
- Eval persistence may reference product thread IDs, but judges must persist their own immutable checks and configuration snapshots.
- Completed review windows are read-only except for turn, layer, case, thread, and node-detail navigation.
- Public product APIs reject caller-selected harness overrides; the Eval app server explicitly enables them.
- The old standalone eval HTML is a lower-level artifact only and is not the Eval application UX.

# API Contract Simulation Laboratory reference

This sealed reference describes one evaluator-owned decomposition, not a required candidate design.

The public process owns an immutable registry of imported revisions, one active revision, per-operation scenario cursors, and an append-only normalized exchange trace. A contract compiler validates documents and examples at import time, turns path templates into anchored matchers, and retains request and response validators beside each operation. An HTTP adapter handles the control plane separately from contract-defined routes. Scenarios delay before selecting the next ordered failure; replacement resets the cursor. Replay reads normalized trace records without invoking routes or advancing scenarios. Revision comparison independently derives removed operations, newly required request inputs, and optional response additions before computing compatibility from the breaking flags.

Qualification observes only the documented process and loopback HTTP seam. Equivalent route-table, compiled-dispatch, class-based, functional, or generated implementations are acceptable. Candidate source text, filenames behind the start command, and resemblance to this decomposition are not evidence.

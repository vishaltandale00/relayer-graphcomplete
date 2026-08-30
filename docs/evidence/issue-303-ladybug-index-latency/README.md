# Ladybug indexing save-latency evidence

Issue #303 qualifies the inline SQLite-to-Ladybug projection on macOS Apple
Silicon. The benchmark authors a deterministic boundary-weighted corpus through
the public graph writer, then times `writer.complete(interaction)` from the call
through its returned acknowledgement. The measured interval includes validation,
SQLite acceptance, closure materialization, the real Ladybug transaction and
checkpoint, revision recording, SQLite commit, and the final accepted-output read.

The corpus uses one versioned seed, ten accepted warm-ups, and 200 measured saves
against one growing SQLite/Ladybug pair. Seventy percent of its buckets are
ordinary one-layer graphs, twenty percent are recursive graphs, and ten percent
exercise the legal five-layer, eight-node width boundary. This is a deterministic
boundary-weighted qualification corpus, not a claim about production telemetry.

Run from a clean, committed Apple Silicon checkout:

```sh
npm run evidence:ladybug-index-latency
```

The gate defines “normally below 100 ms” as nearest-rank p95 strictly below
100,000,000 nanoseconds. The receipt also retains every raw sample, p50, p90,
p99, maximum, every sample at or above 100 ms, and Tukey high outliers. Store
opening and draft authoring are outside the measured save boundary. Deterministic
correctness remains in `crates/relayer-graph-server/tests/search_index_corpus.rs`;
the hardware timing gate is intentionally separate from the default test suite.

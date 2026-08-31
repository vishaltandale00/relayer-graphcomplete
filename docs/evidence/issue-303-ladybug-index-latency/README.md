# Ladybug indexing save-latency evidence

Issue #303 qualifies the inline SQLite-to-Ladybug projection on macOS Apple
Silicon. The benchmark authors a deterministic boundary-weighted corpus through
the public graph writer, then times `writer.complete(interaction)` from the call
through its returned acknowledgement. The measured interval includes validation,
SQLite acceptance, closure materialization, the real Ladybug transaction,
revision recording, SQLite commit, and the final accepted-output read. Ladybug
COMMIT is the acknowledgement boundary; crash recovery is rebuild-first from
canonical SQLite rather than a forced checkpoint on every save.

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

## Captured result

The first receipt was captured from source commit
`5db4714740e2d13aaaa53d71cd656ec81af1be69` on macOS Apple Silicon with pinned
`lbug` 0.18.0. It did **not** pass the gate: p50 was 56.0 ms, p90 was 101.7 ms,
p95 was 143.3 ms, p99 was 163.0 ms, and the maximum was 207.2 ms. Twenty-one of
200 measured acknowledgements took at least 100 ms. That failed receipt remains
preserved in Git history at commit `b0d3aa56`.

After removing the forced per-save checkpoint and adding rebuild-first recovery,
the same corpus passed at integrated source commit `98977a35`: p50 was 16.7 ms,
p90 was 34.4 ms, p95 was 96.2 ms, p99 was 98.2 ms, and the maximum was 102.6 ms.
Two of 200 acknowledgements were at or above 100 ms; the defined nearest-rank p95
gate remained below 100 ms. The checked-in receipt contains that final capture.

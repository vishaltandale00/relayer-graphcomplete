# Ladybug 0.18.0 graph-query-v1 contract probe

This deterministic Issue #261 probe qualifies the frozen fixture corpus against exact `lbug
0.18.0`; it is not the Issue #262 production projection or the Issue #263 parser/executor.

The probe loads the frozen supergraph topology into one shared temporary Ladybug database. Its
private query lowerings preserve the v1 semantics while accounting for known dialect differences:
target publication predicates are injected as physical booleans, absent optional properties have
explicit presence bits, unrooted `CONNECTED` scans choose one canonical orientation, source-layer
occurrence constraints are injected where required, and `NULLS FIRST/LAST` is lowered to a presence
sort key. Every lowered query must parse as read-only before execution.

The executable runs all positive fixture shapes and deep-compares their normalized columns, ordered
tagged rows, stable graph identities, public properties, and truncation flags with the frozen
`positive.json` envelopes. It also exercises every tagged result value represented by Ladybug,
checks transaction rollback across database reopen, records `extensions=[]`, and runs the allowed
two-hop cancellation/timeout falsifier. The companion receipt lint accounts for every case in
`positive.json`, `negative.json`, `values.json`, and `limits.json`, and binds the captured output to
the exact probe source, lockfile, coverage receipt, and positive fixture bytes. Rejections before execution,
authority checks, normalization errors, and result-envelope limits remain Rust contract-boundary
work for Issue #263 and are deliberately not delegated to Ladybug.

Run the receipt-only deterministic check with:

```sh
npm run lint:ladybug-contract-probe
```

Running the native probe additionally requires the pinned static OpenSSL prefix selected by the
Issue #261 source-build receipt:

```sh
OPENSSL_DIR=/absolute/pinned/openssl-prefix OPENSSL_STATIC=1 \
  LIBRARY_PATH=/absolute/pinned/openssl-prefix/lib MACOSX_DEPLOYMENT_TARGET=13.3 \
  RUSTFLAGS='-L native=/absolute/pinned/openssl-prefix/lib -l static=ssl -l static=crypto' \
  cargo run --locked --manifest-path docs/evidence/issue-261-ladybug-contract-probe/Cargo.toml
```

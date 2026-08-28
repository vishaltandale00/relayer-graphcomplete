# Node Redis command-queue race verifier

This evaluator-owned verifier exercises the public Node Redis client against a
loopback RESP server. A private driver with a minimal environment wraps sockets
and loads the candidate, while a separate evaluator process owns the server,
computes every predicate, and alone holds the controller receipt channel. Both
private files are removed before candidate code loads, and candidate stdout is
never treated as a receipt. Socket errors are injected synchronously from selected
`write()` calls, and the targeted bytes are never delivered. This makes the historical
interleaving deterministic on the pinned runtime instead of relying on retired
Node/libuv timing or a live Redis daemon.

Qualification records every predicate independently: failed callback cardinality,
queue cleanup before readiness, offline replay, reconnect usability, reply
ordering, `SET` and `GET` failures over two epochs, queue drainage, and
command/reply association. The candidate is
graded in a pristine clone with only its committed patch applied. The verifier
does not read candidate source text or compare the candidate with the sealed
reference patch.

The reference patch is the still-open upstream PR #1603 proposal. It is sealed
admission evidence, not a prescribed implementation and not a released upstream
fix.

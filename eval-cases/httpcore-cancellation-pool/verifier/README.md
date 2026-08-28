# Sealed verifier contract

The evaluator starts an HTTP/1.1 server bound only to `127.0.0.1`. A code-owned
`AsyncNetworkBackend` wrapper signals after `connect_tcp` is entered, allowing
the evaluator to cancel at the exact historical failure boundary. All later
connects delegate to HTTPCore's public AnyIO backend and real loopback TCP.

Both verifier entry points use Python isolated mode and explicitly load only the
candidate's `httpcore` package. Candidate-root startup hooks, pytest plugins,
tests, and configuration are excluded. The focused regressions execute frozen
upstream test bytes from a separate baseline checkout against that loaded package.
Evaluator output and pytest entry points are captured before candidate loading;
pytest is already running when the package is imported, and qualification requires
the exact frozen-suite summary (`51 passed`) with no skip, failure, or error summary.

The predicates are recorded independently: deterministic cancellation, release
of a one-connection pool slot, a successful follow-up response, three repeated
cancellation/recovery cycles, pool/server cleanup, focused upstream regression
tests, and a clean committed delivery. Qualification runs against a pristine
clone with only the candidate's committed diff applied.

The verifier never reads candidate source, matches text, imports a reference
patch, contacts a public network service, or enforces a hidden file allowlist.
It is a behavioral coding verifier, not a security sandbox for arbitrary hostile
code in the candidate Python process. The sealed admission mutants cover concrete
root, package, evaluator-main, capacity, repetition, and cleanup shortcuts; host
execution isolation remains a separate authority boundary.

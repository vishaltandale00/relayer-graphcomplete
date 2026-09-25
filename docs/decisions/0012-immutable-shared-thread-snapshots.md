# ADR 0012: Immutable shared-thread snapshots

Status: accepted; local production implementation in progress

## Context

Issue #461 settles public thread sharing as one frozen, read-only publication of
accepted history. Ordinary conversation export also carries drafts and local
recovery information, so publishing cannot be a renamed download route or a
renderer-owned network operation. Retries, viewer compatibility, redaction, and
owner-scoped service idempotency need one byte-stable boundary.

## Decision

Rust owns a share-export operation beside ordinary conversation export. At
`Create link` it reads the persisted product and graph state once and emits
conversation-export v1 JSONL containing only accepted completions. It refuses
imported threads and threads without accepted history. Pending, draft, stopped,
and failed work is not promoted to accepted history.

The share export preserves the accepted turn order, nested layers, Node Details,
action provenance, and export-local references. It removes permission receipts,
execution and harness-configuration digests, and admitted model plans while
retaining completion status, model selection, and the harness configuration
name. Known secrets, credential shapes, and private paths are redacted from
conversation content, including rich detail fragments. The chosen public title
replaces the exported local title, while the chosen title and project display
name are published unchanged except for ordinary safe HTML and inert-data
handling. The local thread is not renamed.

The exporter returns one immutable byte sequence or a closed failure. It never
truncates. Bytes above 16 MiB fail before publication. Electron main owns those
bytes and the owner-bound attempt/reference identity. Renderer code receives a
closed progress/result presentation but no bearer token, signed upload fields,
or direct service authority. Every retry of one attempt reuses the exact bytes
and identity; a deliberate new Share action creates both anew.

The share service treats graph semantics as opaque. It validates version, total
bytes, line bounds, and per-line JSON syntax, binds finalization to the exact
staged object identity, and publishes one immutable object. The public viewer
uses a versioned snapshot reader and the production ProductWorkspace in a
read-only host. It starts at the first accepted turn, leaves the URL unchanged
during navigation, disables execution, and has no client telemetry or snapshot
fetch authority.

Durable attempt recovery across application restart is owned by Slice 3 (#466)
after exporter and service contracts stabilize. A local Gate B path may exercise
the same contract with deterministic storage, authentication, cache, and
transport fakes; it is not deployed-service evidence.

## Consequences

- `complete(inputGraph)`, graph acceptance, and draft/accepted/stopped semantics
  do not change.
- Ordinary conversation export remains independently compatible and testable.
- Every published format version remains readable; security exceptions for
  already-pinned viewer assets require a separate product decision.
- Real exports remain local test inputs and never enter committed fixtures or
  public evidence.
- Deployment, IAM, live Auth0, live Sentry, and full-size network proof remain
  separately authorized Gate C work.

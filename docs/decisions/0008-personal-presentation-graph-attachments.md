# ADR 0008: Personal presentation graph attachments

## Status

Accepted

## Context

Relayer needs a product-owned way to guide how an accepted answer is presented without turning presentation preferences into prompt strings, user-visible response topology, or mutable per-harness settings. The preference source must remain an ordinary accepted GraphComplete graph, while each execution needs a stable version identity for retries, traces, and Eval comparison.

## Decision

Relayer owns one hidden personal-presentation profile thread. Its V0 and V1 records are ordinary product interactions whose accepted graph completions are immutable published versions. V0 is a neutral manifest. V1 contains the initial decision-useful-center and adaptive-progressive-disclosure preference nodes.

The product database reserves negative row identities for this singleton hidden
thread and its source interactions. They remain valid foreign-key-backed rows
but cannot consume or collide with the positive product IDs used by ordinary
conversation records. The graph database has an independent positive identity
namespace and reserves one standalone thread identity for profile
materialization. Ordinary graph interaction creation rejects that identity;
only the dedicated authenticated profile-creation boundary can use it. The
product's negative row identity is therefore never reused as graph visibility
authority.

Graph core stores publication and attachment as control relations. A publication registers an accepted standalone completion root in one profile thread. An attachment pins one published, non-retired version interaction and its root layer to one accepted root interaction. It is neither a `GraphEdge`, `GraphAction`, context occurrence, nor accepted response record. It therefore does not enter completion closure, topology, navigation, Node Details, or conversation export. Control-authenticated reads may resolve the attached accepted graph; an interaction-scoped graph capability may read only its own resolved attachment.

Interaction creation selects the thread's requested Eval version or the currently active product version and inserts the pin in the same immediate transaction as the interaction. Creation fails atomically when that version is missing, unpublished, retired, or inconsistent. The pin is immutable and idempotent. Changing the active policy affects only interactions created afterward; preparation, retry, and recovery validate and reuse the stored pin. The app server attaches that pin before provider execution and incorporates the version identity into the effective execution digest.

The harness host renders the accepted preference nodes through one provider-neutral renderer. Generic graph-authoring guidance comes first, rendered personal presentation guidance second, and normalized task input last. Explicit user presentation instructions outrank attached preferences, which outrank provider defaults. The root agent and native children that can author graph content receive the same guidance; unrelated delegates do not. Harnesses retain native recursion ownership.

Execution traces and Eval artifacts record only `personalPresentationVersionId`. They do not duplicate the source graph as metadata or create a visible product ornament. Historical records without the field remain valid. Eval's V0 and V1 named Codex configurations differ only by the requested version after their configuration names are normalized, so the existing case, matrix, judge, renderer, and artifact contracts remain unchanged.

## Consequences

- `complete(inputGraph)` remains the canonical execution boundary and `graph.submit` remains the only completion transition.
- Product and graph stores retain their separate ownership. Startup materializes and publishes built-in graph versions before an interaction can pin them.
- Missing attachments remain readable for historical interactions. New product executions fail closed if their selected version is missing, unpublished, retired, or inconsistent.
- Activating a new version is a product-policy operation after evidence; it never rewrites historical pins.
- V1 deliberately adds no preference editor, attachment UI, export field, pairwise Eval judge, new metric, or harness scheduler.

## Verification

Focused graph-core, control-authority, storage migration, atomic-pinning, renderer-ordering, native-child propagation, export-privacy, trace-attribution, Eval-matrix, and product-path tests cover the contract. Live inference remains opt-in and outside the default suite.

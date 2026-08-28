# ADR 0008: Node-authored input actions materialize immutable direct interaction input

## Status

Accepted.

## Context

An accepted response node may need to collect structured user input for the thread's next
ordinary interaction. This is not navigation, immediate invocation, an ordinary graph edge, or
the control-authored `interaction.context` relation from ADR 0007. In particular, collecting one
value must not start model work, and presenting the same node or action in more than one accepted
completion must not create one global mutable answer.

The product already owns durable thread composer state and the lifecycle that creates a canonical
root interaction before calling `complete(inputGraph)`. `inputGraph` is the graph-scoped pointer to
that interaction. GraphComplete owns accepted
action identity, occurrence visibility, graph input materialization, normalized model input, and
submission authority. These responsibilities remain separate.

## Decision

### Authored action

`input` is a model-authored, node-owned `GraphAction` kind. It uses the existing action identity,
presentation envelope, source node, exact authored source-layer provenance, stable client-key
replay, draft, and accepted-state rules. Its subtype payload is exactly one of:

```ts
type InputActionPayload =
  | { control: "text"; prompt: string }
  | {
      control: "single_select";
      prompt: string;
      options: readonly { key: string; label: string }[];
    }
  | {
      control: "multi_select";
      prompt: string;
      options: readonly { key: string; label: string }[];
      minimumSelections?: number;
    };
```

The common `label`, `variant`, `icon`, and card `description` fields continue to describe how the
action is activated. The subtype payload describes the control after activation. An input action
has no navigate relation, target layer, invoke interaction text, lease, response flag, or dynamic
dependency on another action.

Input metadata uses UTF-8 byte bounds so every client validates the same contract:

- `prompt` is non-whitespace and at most 2,000 bytes;
- a select has 1 through 50 options;
- each option key is 1 through 128 bytes, contains no NUL, and has no leading or trailing
  whitespace;
- option keys are unique by exact byte equality within the action;
- each option label is non-whitespace and at most 512 bytes;
- `minimumSelections`, when present, is an integer in `1..=options.length` and is valid only for
  `multi_select`.

These are structural storage and resource-integrity bounds required by #217, not a declarative
validation language. Custom constraints and richer validation messages remain in #203.

Text actions reject `options` and `minimumSelections`. Single-select actions require `options`
and reject `minimumSelections`. Multi-select actions require `options`. Unknown control variants
and unknown subtype fields fail closed. Validation happens before a draft action is persisted and
again before its containing output can be accepted. A rejected whole-program replay can repair the
same draft by retaining its source node and client key.

Input actions are ordinary accepted output membership, but they are not navigation or invocation.
They never count as the interaction root action, target a layer, participate in closure traversal,
create reference arrivals, resolve an invoke lease, or alter recursive depth. Like other newly
authored non-root actions, they require a current draft source node and its exact draft source layer.
A reference-arrived layer remains restricted by ADR 0005 and therefore cannot newly author an
input action.

### Presenting occurrence and durable slot

The authority identity of one presented input action is a named value:

```ts
interface PresentingInputOccurrence {
  presentingInteractionNodeId: GraphId;
  presentingLayerId: GraphId;
  actionId: GraphId;
}
```

The action's source node is derived from the accepted action and retained for display and
diagnostics; a renderer-supplied source node is never trusted. To validate the tuple, graph control
proves that the presenting interaction has an accepted completion, that the presenting layer is
reachable in that exact accepted completion, that its immutable layer snapshot contains the
action's source node and action, and that the occurrence is visible in the destination thread's
established project or standalone-thread scope. The action's original authored source layer may
differ from the presenting layer when an accepted node-owned action is reused.

The product owns one durable unsent draft per thread. It stores at most one committed attachment
per `PresentingInputOccurrence`. This permits several input actions on one node and independent presentations
of a reused action. Commit is an idempotent create-or-replace of that slot at an expected draft
revision; detach is an idempotent delete. Both Commit and Send revalidate the tuple and accepted
action snapshot with graph control. Imported, read-only, stale, inaccessible, forged, or mismatched
occurrences have no mutation authority.

Only the committed value is durable. A staged editor value belongs to the renderer and is neither
autosaved nor available to GraphComplete. Reopening a control starts from the committed value;
Undo restores that value; detaching makes a later reopen empty. Persistence failure leaves the
prior committed revision authoritative and must not be presented as a successful commit.

Committed attachments are semantically unordered. UI order is presentation only and is never
stored as priority. Product storage may retain a display timestamp, but it is excluded from
equality, idempotency, materialization, model input, and export semantics.

### Submitted values

A text value is the user's exact string and must contain at least one non-whitespace character.
A single-select value is exactly one known option key. A multi-select value is a set of unique
known option keys and satisfies `minimumSelections` when present. Selection order has no semantic
meaning. Materialization snapshots the exact prompt, control, relevant option keys and labels, and
submitted text or selected keys and labels from the accepted action; it never trusts renderer-
supplied labels or action metadata.

Graph storage represents each submitted value as a dedicated immutable
`interaction_input_child` record with its own `InteractionInputChildId`. The record contains:

- its one parent canonical root interaction node;
- the exact accepted input action and presenting source interaction and layer;
- the derived source response node;
- the self-contained action and submitted-value snapshot; and
- the product attempt key and canonical input digest used for idempotent preparation.

The parent column is the typed root-to-child `interaction.input` relation. The provenance columns
are typed child-to-action and child-to-presenting-occurrence relations. None is an ordinary
`GraphEdge`. The dedicated child ID is exposed only by interaction-input, history, Eval, export,
and diagnostic projections; it is not a `NodeId` and is rejected by node, edge, layer, neighbor,
authoring, capability-minting, invocation, and completion APIs. A child belongs directly to exactly
one root, cannot have children, and cannot be mutated after preparation.

Dedicated records make the isolation rule structural: children cannot join response layers,
ordinary topology, closure traversal, recursive depth, orphan detection, reference-arrival logic,
or root-action counting. They cannot be independent completion roots or receive graph-authoring
authority. Ordinary neighbor reads do not expose them.

### Canonical equality, digesting, and normalized model input

Before hashing or persistence, attachments are sorted by ascending numeric
`(presentingInteractionNodeId, presentingLayerId, actionId)`. Selected option keys are sorted by
exact UTF-8 bytes. Duplicate occurrences or duplicate selected keys are validation errors, not
values to collapse. Options retain accepted authored order.

The canonical JSON bytes are the UTF-8 encoding produced by RFC 8785 JSON Canonicalization Scheme
(JCS). JCS fixes property sorting, string escaping, number serialization, and insignificant
whitespace; arrays retain the semantic order specified here. Strings receive no Unicode or
whitespace normalization before JCS encoding. IDs are positive JSON integers in the product's
existing cross-client safe range. Absent optional fields are omitted rather than encoded as
`null`. The exact JSON value schemas are:

```ts
type CanonicalActionV1 =
  | { control: "text"; prompt: string }
  | {
      control: "single_select";
      prompt: string;
      options: readonly { key: string; label: string }[];
    }
  | {
      control: "multi_select";
      prompt: string;
      options: readonly { key: string; label: string }[];
      minimumSelections?: number;
    };

type CanonicalValueV1 =
  | { text: string }
  | { selected: readonly { key: string; label: string }[] };

interface AuthorityAttachmentV1 {
  presentingInteractionNodeId: GraphId;
  presentingLayerId: GraphId;
  actionId: GraphId;
  action: CanonicalActionV1;
  value: CanonicalValueV1;
}

interface AuthorityDigestInputV1 {
  schemaVersion: 1;
  text: string;
  attachments: readonly AuthorityAttachmentV1[];
}

interface SemanticAttachmentV1 {
  action: CanonicalActionV1;
  value: CanonicalValueV1;
}

interface SemanticDigestInputV1 {
  schemaVersion: 1;
  text: string;
  submittedInputs: readonly SemanticAttachmentV1[];
}
```

The authoritative `text` is the exact frozen product string; trimming is used only to decide
whether text is empty. In `CanonicalValueV1`, text controls use `text` and select controls use
`selected`. Each selected entry snapshots its accepted key and label and follows sorted key order.
Authority attachments follow occurrence order. Semantic attachments are sorted by the UTF-8 bytes
of their own compact canonical JSON; equal entries remain repeated, so multiplicity is preserved.

Two versioned SHA-256 digests serve different boundaries:

- the **authority digest** is
  `sha256:interaction-input-authority:v1:<lowercase hex>` over `AuthorityDigestInputV1`; product
  attempt binding and graph preparation use it;
- the **semantic digest** covers root text plus the self-contained prompt/control/options/value
  snapshots in `SemanticDigestInputV1`, omits local IDs, authority metadata, display order, and
  timestamps, and is encoded as `sha256:interaction-input-semantic:v1:<lowercase hex>`.

Both digests are invariant under attachment order and multi-select order. Retrying graph
preparation with the same product attempt key and authority digest returns the same root and child
IDs. Reusing the attempt key with different canonical bytes fails closed. A new Send after a
terminal failed or cancelled attempt always has a new attempt key even if its semantic digest is
unchanged.

`getInteractionInput()` from `inputGraph` returns the root message, ADR 0007 contexts, and a
canonically sorted `submittedInputs` collection. Each submitted input contains only its
self-contained semantic snapshot. It omits local child IDs, action IDs, presenting occurrence IDs,
source paths, attempt keys, and authority digests. Every TypeScript and Python client, harness, and
provider-native child uses this same graph-capability read. Prompt concatenation and
provider-specific side channels are not equivalent implementations. The normalized collection
assigns no sequence, priority, or independent work to a child.

### Send and recovery boundary

Send is valid when trimmed root text is non-empty, at least one committed input attachment is
valid, or both. The product and graph databases do not pretend to share one transaction. Instead,
the following durable preparation protocol is the execution barrier:

1. In one product transaction, reserve a new immutable attempt key, snapshot the thread draft
   revision and committed slots, store the frozen execution identity, and mark that draft revision
   locked.
2. Graph control revalidates every occurrence and value, then in one graph transaction creates or
   recovers the canonical root and exact child set keyed by the attempt key and authority digest.
3. In one product transaction, bind the attempt to that root, child-set receipt, and digests.
4. Only a fully bound attempt may claim `running` and invoke exactly
   `complete(inputGraph)`.

Thus no inference starts while product and graph input are partial or mutually inconsistent.
Duplicate Send or response loss resumes the same nonterminal attempt and cannot create a second
root, child set, inference run, or protected side effect. Startup reconciliation completes or
fails preparation before considering execution.

Accepted `graph.submit(rootInteractionNode)` is authoritative success. Startup or late product
finalization adopts an already accepted graph result and never restores its input. Successful
finalization freezes the attempted values as read-only history and durably consumes the locked
draft revision.

If execution terminates or is cancelled before graph acceptance, product finalization preserves
the immutable failed attempt and copies its attachment snapshots into a new editable draft
revision. It never unlocks or mutates the attempt. If an identical slot already exists in a newer
editable draft, exact identity and value are idempotent; a conflicting newer user edit wins and the
restored copy is reported as a recovery conflict rather than silently overwriting it. Resend always
creates a new attempt and root. A cancellation observed after graph acceptance is recorded as late
but cannot reopen input. General retry UX and rollback of external side effects remain out of
scope.

### Stable validation identities

Graph, product, server, TypeScript, and Python boundaries preserve these codes and field paths.
Messages include the stated repair and may add context without changing the code:

| Code | Path | Repair |
| --- | --- | --- |
| `input_action_prompt_required` | `prompt` | Supply a non-whitespace prompt. |
| `input_action_prompt_too_long` | `prompt` | Shorten the UTF-8 prompt to 2,000 bytes. |
| `input_action_options_required` | `options` | Supply 1 through 50 options for a select. |
| `input_action_options_unexpected` | `options` | Remove options from a text action. |
| `input_action_option_count` | `options` | Keep the option count in `1..=50`. |
| `input_action_option_key_invalid` | `options[i].key` | Use a nonempty, trimmed, NUL-free key of at most 128 bytes. |
| `input_action_option_key_duplicate` | `options[i].key` | Give every option an exact unique key. |
| `input_action_option_label_required` | `options[i].label` | Supply a non-whitespace label. |
| `input_action_option_label_too_long` | `options[i].label` | Shorten the UTF-8 label to 512 bytes. |
| `input_action_minimum_unexpected` | `minimumSelections` | Remove it unless the control is multi-select. |
| `input_action_minimum_invalid` | `minimumSelections` | Use an integer in `1..=options.length`. |
| `input_action_control_unsupported` | `control` | Use `text`, `single_select`, or `multi_select`. |
| `input_action_payload_unexpected` | offending field | Remove every field not defined by the selected input control, including navigate, invoke, or unknown subtype fields. |
| `input_occurrence_not_accepted` | `attachments[i].presentingInteractionNodeId` | Reopen an action from accepted history. |
| `input_occurrence_not_visible` | `attachments[i]` | Remove an occurrence unavailable to this thread scope. |
| `input_action_not_in_occurrence` | `attachments[i].actionId` | Reopen and commit the action from the exact presenting layer. |
| `input_action_snapshot_mismatch` | `attachments[i]` | Refresh the accepted action and recommit its value. |
| `input_attachment_duplicate` | `attachments[i]` | Send at most one value for each exact occurrence. |
| `input_text_blank` | `attachments[i].value` | Enter non-whitespace text or detach the input. |
| `input_option_unknown` | `attachments[i].value` | Select only keys from the accepted action snapshot. |
| `input_option_duplicate` | `attachments[i].value` | Remove repeated multi-select keys. |
| `input_selection_count` | `attachments[i].value` | Meet that action's exact selection count or minimum. |
| `interaction_input_required` | `interaction` | Supply nonempty root text or at least one valid child. |
| `interaction_input_attempt_conflict` | `attemptKey` | Recover the existing attempt instead of reusing its key with different input. |

Structural action rules from ADR 0005 keep their existing codes. Multiple independent problems
are returned as ordered validation issues where the current API supports them. Validation order is
shape, occurrence authority, accepted snapshot, then value, with array indices following canonical
attachment order. This makes repair output deterministic without using deterministic rules as a
substitute for model judgment.

### Compatibility, portability, and read projections

Graph migration adds the `input` action kind, a one-to-one input-action payload table, dedicated
child records, and typed indexes without rewriting existing action, node, layer, completion,
context, invoke-lease, or accepted-snapshot rows. Existing databases gain empty tables and nullable
or additive discriminants; old accepted actions retain identical reads. Unknown future action or
control variants fail closed before acceptance instead of degrading to navigation, invocation, or
plain text.

Conversation V1 gains an optional additive `inputs` collection on a turn. Each entry uses
export-local IDs and snapshots the child semantic content plus authority-free provenance. Entries
are sorted canonically; repeated exported snapshots use the existing export-local deduplication
rules. Unsent drafts, producer database IDs, paths, attempt keys, capability data, and local
authority never export. Import allocates fresh inert child IDs, preserves accepted, failed,
cancelled, and stopped attempt evidence, and cannot create a draft, capability, invocation, or
completion. Absence of `inputs` means no child input, so old exports remain valid. An older reader
that cannot ignore the additive field must reject the new document before mutation; silently
flattening or dropping submitted input is not safe degradation.

Ordinary history stays compact and shows submitted input only under the consuming interaction.
Selecting an earlier or later use of the same source action resolves that turn's immutable child
snapshot, never one mutable answer on the source action. Read-only Eval and diagnostics may expose
safe provenance, attempt state, and digests, but those projections confer no authority.

### Existing contracts remain unchanged

- `complete(inputGraph)` remains the sole external completion boundary, and a model turn
  ending remains distinct from graph completion.
- ADR 0005 `navigate.expand`, `navigate.reference`, source-layer provenance, accepted closure,
  orphan, layout, root-action, invoke-lease, and native-recursion rules are unchanged.
- ADR 0007 `interaction.context` remains control-authored root-to-accepted-node context with ordered
  annotations. Input children neither replace nor reorder contexts.
- Ordinary `GraphEdge`, neighbor, layer, and accepted-history semantics are unchanged.
- Product storage owns unsent drafts and attempt chronology; GraphComplete and harnesses cannot read
  partial or staged input before Send.
- Rich declarative validation, recursive child-input trees, reactive controls, release, deployment,
  and a GraphComplete or harness-level scheduler remain out of scope.

## Consequences

- Multiple actions on one node and reuse of one action in different accepted presentations remain
  independent because the slot identity includes the presenting occurrence.
- Dedicated child records cost a new typed projection, but prevent accidental participation in
  output graph algorithms more reliably than flags on ordinary nodes.
- Two canonical digests keep authority/idempotency checks separate from provider-visible semantics.
- The durable preparation protocol closes partial cross-database input windows without claiming a
  distributed transaction or permitting inference before binding.
- Production schema, API, client, recovery, renderer, portability, and evidence work may begin only
  after the throwaway state-model prototype in #219 receives its required human verdict.

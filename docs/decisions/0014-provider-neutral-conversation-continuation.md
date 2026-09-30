# ADR 0014: New conversations continue through the graph, not a provider session

## Status

Accepted for #584. The building blocks ship inert. One final enabling change
makes every new conversation a continuation conversation, and it merges only
after the #584 Relayer Dev human gate and the live read-before-acting test
pass.

## Context

Harness prompts carry only the current turn. Earlier turns reach the agent
only through a resumed provider session. Resets, provider homes, and harness
changes therefore lose conversation context. ADR 0006 pins one harness
configuration per thread.

[#597](https://github.com/vishaltandale00/relayer-graphcomplete/pull/597)
contains existing conversations to the route proven by their successful
root receipts (PRD AGT-011 and AGT-012). That containment is correct for
conversations whose history exists only natively. It must not become the
permanent model for new ones.

## Decision

The thread owns the durable conversation, and the graph is its record.
Harness, provider, and model are per-turn execution choices.

- **Explicit format.** Each thread records `conversation_format`: `legacy`
  or `continuation-v1`. It is set once at creation and never changes.
  Existing and imported threads are `legacy`. Private provider homes,
  native home bindings, and native session identities never imply the
  continuation format.
- **Legacy stays contained.** A legacy conversation keeps #597's derived
  status (`unrestricted`, `compatible`, or `blocked`), its Send, retry, and
  admission checks, and its required native continuity. Its prompts do not
  change, and it gets no conversation read.
- **Continuation is portable.** A continuation conversation reports the
  `portable` status. Original-route containment and required native
  continuity do not apply. Catalog, model-rule, permission, and access
  checks still apply. The permission profile stays pinned to the thread.
- **No pasted history.** A prompt never contains earlier turns. A fresh,
  switched, or reset native session receives the current turn and its
  attachments, as today.
- **On-demand read.** A running turn reads earlier root turns of its own
  conversation through a read-only, completion-scoped graph API. For each
  turn, it returns in order:
  - the message, attachments, notes, and submitted inputs;
  - the outcome and effect class;
  - a bounded action ledger;
  - node and layer pointers to the accepted answer or retained work.

  It is not graph search. It grants no navigation or edit authority.
- **Frozen order.** Order and outcomes live in the product database.
  Product therefore freezes the ordered turn list into graph control
  atomically with each new interaction. A freeze failure refuses the turn
  before inference and preserves the draft.
- **Standing guidance.** Every Codex, Claude, and Prime prompt in a
  continuation conversation says the read exists and when to use it. There
  is no per-turn hint. The agent decides when to read.
- **Native sessions are an optimization.** The host keeps one native slot per
  harness configuration used. A native reset keeps #571's diagnostic, which
  adds that earlier turns remain readable through the graph.

## Consequences

- ADR 0006's "V1 threads pin one harness configuration" consequence now
  applies to legacy conversations only.
- `complete(inputGraph)`, graph acceptance and authority, and harness-owned
  recursion are unchanged. Semantic children receive no pasted history and
  may use the read under their own authority.
- The only native-only information made durable is the adapter action
  ledger. Transcripts, hidden reasoning, and tool output bytes are not
  retained.
- Faithful continuation depends on agents choosing to read. The live test
  requires at least 90% reads before acting on context-dependent turns, per
  harness, plus a passing outcome judge. Deterministic checks prove data and
  prompts, not model behaviour.
- No existing conversation is migrated. No native session file is copied or
  moved.

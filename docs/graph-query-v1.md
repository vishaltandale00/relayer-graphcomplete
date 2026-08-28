# Relayer graph query contract, version 1

Status: frozen contract for Issue #260. Runtime implementation and Ladybug qualification are
owned by later Issue #52 DAG nodes.

This document defines Relayer's deliberately bounded, read-only, GQL/Cypher-shaped graph query
profile. It does not claim compatibility with complete Cypher or ISO GQL. The normative
engine-neutral examples are in `fixtures/graph-query-v1`; if prose and a fixture disagree, the
fixture manifest identifies the contract version and the disagreement must be resolved before a
runtime claims conformance.

## 1. Boundary and authority

The semantic boundary is:

```text
query(readPermit, resolvedTarget, queryText, parameters, budget) -> QueryResult
```

`resolvedTarget` is exactly `{ scope: "thread" | "project", id: positive-integer }`. The product
defaults an omitted user choice to the current thread before calling this boundary. Another thread
or a project must be selected explicitly. V1 provides no thread/project discovery operation.

The target selects a logical dataset; it is not authority. Trusted product/graph control derives
project and thread provenance from the canonical completion interaction and resolves the selector.
The Rust graph core intersects that target with the transaction-local completion-bound read permit
defined by Issue #234. Query text, parameters, client fields, and physical database names cannot
widen the immutable maximum entitlement. A broader read grant never widens write authority,
exposes a foreign draft, or makes a returned value a capability. Search and exact graph reads use
the same core authorization seam. Missing and inaccessible target identities use the same
`inaccessible_or_missing` result; `scope_not_granted` is used only when revealing that the requested
scope class is unavailable does not reveal a record's existence.

Every accepted record retains immutable origin provenance `{ project_id, thread_id }`. Publication
also stores explicit logical target membership derived from accepted closure/snapshot occurrences;
it is not reconstructed from relationship endpoints during query execution. A project-backed
record belongs to its project publication partition. A thread query includes records explicitly
published in that thread's accepted occurrences, including an older accepted record reused in a
later thread, without rewriting its origin thread. A derived membership belongs to each target in
which both its immutable Layer snapshot occurrence and member Content are explicitly published.
Edges and actions likewise carry their own origin provenance and explicit publication targets, and
are admitted only where both endpoint records are published. Standalone records have no project
partition and may be published only to their exact standalone thread. Same-project visibility in a
permit does not silently add a record to another thread dataset.

Only accepted, published GraphComplete records enter the v1 dataset. Draft and stopped records,
including self-owned drafts, are absent. Earlier design notes discussed a `reachable` selector,
active completion currents, and historical-current ranking. They are not part of v1. Accepted
current/invoke facts may be added only by a later contract owned by their lifecycle feature.

Ladybug backs every graph query from the first graph-search release. One shared embedded Ladybug
store contains logically partitioned targets; SQLite remains the canonical typed GraphComplete
write store initially and is never a production search fallback. An accepted SQLite closure is not
acknowledged until its idempotent projection is committed and verified in one Ladybug transaction.
A search after acknowledgement includes that closure; a concurrent search may observe the prior
published revision, never a partial closure. This is acknowledgement-level freshness, not physical
cross-database ACID. Readiness and ordering are per logical target so one broken target does not
stall others. While SQLite is canonical, incompatibility/corruption is handled rebuild-first from
SQLite with validation and atomic active-store swap. V1 requires no permanent Ladybug fork.
Making Ladybug canonical and vector/index freshness are separate future cutovers.

## 2. Request envelope

An engine-neutral request has these fields:

```json
{
  "queryContractVersion": 1,
  "target": { "scope": "thread", "id": 41 },
  "query": "MATCH (n:Content) RETURN n.title AS title",
  "parameters": {},
  "budget": {}
}
```

Parameter names are ASCII identifiers and are unique. Parameters use the tagged wire algebra in
Section 7. A client may request smaller budgets, but cannot raise implementation maxima. The public
request has no physical-store, database, extension, procedure, candidate-source, or authority
field.

## 3. Admitted grammar

Whitespace and comments are allowed only between tokens. Comments are `//` through end of line.
Keywords and schema names are ASCII case-insensitive; bindings, aliases, parameter names, and
property names are case-sensitive. A semicolon is allowed only as the final token. String and
numeric query literals are deliberately absent: values are parameters, except for the nonnegative
integer `LIMIT` literal.

```ebnf
query          = match-clause, [where-clause], return-clause,
                 [order-clause], [limit-clause], [";"] ;
match-clause   = "MATCH", pattern-part, {",", pattern-part} ;
pattern-part   = [identifier, "="], node-pattern,
                 {relationship-pattern, node-pattern} ;
node-pattern   = "(", identifier, [":", node-label], ")" ;
node-label     = "Content" | "Layer" ;

relationship-pattern = undirected-connected | directed-relationship
                     | reverse-directed-relationship ;
undirected-connected = "-[", [identifier], ":CONNECTED]-" ;
directed-relationship = "-[", [identifier], ":", directed-type, "]->" ;
reverse-directed-relationship = "<-[", [identifier], ":", directed-type, "]-" ;
directed-type  = "CONTAINS" | "EXPANDS" | "REFERENCES" ;

where-clause   = "WHERE", predicate, {"AND", predicate} ;
predicate      = property, compare-op, parameter
               | property, "IS", ["NOT"], "NULL"
               | property, "IS", ["NOT"], "ABSENT" ;
compare-op     = "=" | "<>" | "<" | "<=" | ">" | ">=" ;
property       = identifier, ".", property-name ;
parameter      = "$", identifier ;

return-clause  = "RETURN", ["DISTINCT"], return-item, {",", return-item} ;
return-item    = expression, ["AS", identifier] ;
expression     = identifier | property | parameter
               | list-expression | record-expression | aggregate-expression ;
list-expression = "[", [expression, {",", expression}], "]" ;
record-expression = "{", record-field, {",", record-field}, "}" ;
record-field   = identifier, ":", expression ;
aggregate-expression = "count", "(", "*", ")"
                     | "count", "(", ["DISTINCT"], expression, ")"
                     | aggregate-name, "(", ["DISTINCT"], expression, ")" ;
aggregate-name = "min" | "max" | "sum" | "avg" | "collect" ;

order-clause   = "ORDER", "BY", order-item, {",", order-item} ;
order-item     = identifier, ["ASC" | "DESC"],
                 ["NULLS", ("FIRST" | "LAST")] ;
limit-clause   = "LIMIT", (unsigned-integer | parameter) ;

identifier     = ASCII-letter-or-underscore,
                 {ASCII-letter-or-digit-or-underscore} ;
property-name  = identifier ;
```

Each pattern part contains zero, one, or two relationships. Zero relationships is a whole-target
label scan. The typed planner rejects a pattern part with more than two relationships and rejects a
set of joined pattern parts whose shared bindings impose a traversed connected path longer than two
relationships. Splitting a longer path across commas is not an escape.

One matched path is a relationship-unique trail: the same stable relationship identity cannot be
used twice in one path, including by traversing an undirected edge forward and then backward.
Different relationship identities may connect the same vertices only if the GraphComplete schema
admits them. V1 GraphEdge integrity rejects self-edges and duplicate undirected endpoint pairs, so
CONNECTED has neither self-loops nor parallel edges. CONTAINS and action relationships retain their
own typed identities and may share endpoints when their owning graph contracts allow it.

A node label may be omitted only when every possible incident relationship endpoint implies one
vertex type (`CONNECTED` endpoints are Content; `CONTAINS` is Layer-to-Content; navigation is
Content-to-Layer). Conflicting implications are a type error. A zero-hop node pattern must declare
`Content` or `Layer`; `MATCH (n)` is rejected as type-ambiguous.

`CONNECTED` is matched only with undirected syntax. The other relationship kinds require an arrow;
either textual direction is accepted and normalized to canonical start/end direction in the plan.
Labels and relationship kinds are static tokens. Dynamic labels, relationship kinds, property
names, projections, and ordering keys are forbidden.

Every binding is introduced exactly once and has one inferred type. A path binding may prefix only
a pattern that contains at least one relationship. `ORDER BY` names resolved output columns, not
arbitrary hidden expressions. Output column names are resolved as follows: an explicit alias wins;
a bare binding uses its binding name; a property uses its property name. Every other expression
requires an alias. Resolved output names must be unique.

Only the listed aggregate functions exist. `count(*)` is allowed; `*` is otherwise forbidden, so
`min(*)`, `collect(*)`, and `count(DISTINCT *)` are invalid. An aggregate expression may not contain
another aggregate expression.
Aggregated and nonaggregated expressions cannot be mixed unless every nonaggregated expression is
an identical grouping expression. `collect` is subject to homogeneous-list and work budgets. There
are no subqueries, `OPTIONAL MATCH`, unions, comprehensions, case expressions, user functions, or
procedure calls in v1. The pure-read procedure allowlist is empty.

An empty list literal is admitted only where an enclosing typed expression supplies one exact
element type. V1 has no cast annotation, so a top-level `RETURN [] AS values` and an empty list in an
otherwise unconstrained record field are rejected with `query_type_mismatch`. Tagged empty-list
parameters carry their required `elementType` explicitly.

Mutation (`CREATE`, `MERGE`, `SET`, `DELETE`, `REMOVE`, `DROP`), DDL, transactions, procedure
calls, extension loading/installation, imports, exports, filesystem/network operations, physical
database selection, arbitrary variable-length paths (`*`, `+`, ranges), and unsupported syntax are
rejected during parsing or typed planning before Ladybug execution. A keyword blacklist is not a
valid implementation: conformance is admission by this grammar and typed schema.

## 4. Typed plan vocabulary

The parser produces a plan with these closed concepts:

- `queryContractVersion`: exactly `1`;
- `candidateSource`: exactly `"structural"` for every public v1 query;
- `patterns`: ordered pattern parts containing `pathBinding`, `nodes`, and `relationships`;
- a node plan: `binding`, `label` (`Content` or `Layer`), and occurrence index;
- a relationship plan: optional `binding`, one of the four relationship types, canonical
  `direction`, `from`, and `to` bindings;
- `predicates`: ordered `propertyComparison`, `nullTest`, or `absenceTest` operations;
- `projection`: `distinct` plus ordered columns with unique `name` and a typed expression tree;
- `aggregation`: grouping expressions and aggregate expressions when present;
- `ordering`: output-column name, direction, and null placement;
- `limit`: an optional literal or parameter expression;
- `maxTraversalHops`: `0`, `1`, or `2` after joined-pattern validation;
- `requiresOccurrenceConstraint`: true for every plan that joins `CONTAINS` to `EXPANDS` or
  `REFERENCES` through a Content binding.

The plan never contains a Ladybug table/column name or raw query fragment. Target predicates,
publication predicates, and the permit are injected by the Rust executor independently of query
text and are not represented as user-authored predicates.

The internal candidate-source interface is versioned separately from public syntax. V1 emits only
`structural`. A future vector or late-interaction source may feed candidates into the same typed
filter/projection/budget pipeline, but no vector term, embedding, score, index, or ranking syntax is
reserved or accepted in v1.

## 5. Searchable supergraph

One shared Ladybug store holds logically partitioned targets. Physical schema is private. The
public logical schema is:

```text
(layer:Layer)-[:CONTAINS]->(content:Content)
(content:Content)-[:CONNECTED]-(other:Content)
(content:Content)-[:EXPANDS|REFERENCES]->(target:Layer)
```

### Vertices

`Content` represents one accepted GraphNode. Its stable public identity is `content:<graph-id>` and
its visible properties, in canonical order, are `kind`, `icon`, `title`, `detail`, and `state`.
`state` is always `accepted` in v1. Lease identity, owner, project/thread provenance, client keys,
and internal row IDs are not visible properties.

`Layer` represents one accepted GraphLayer snapshot. Its stable identity is `layer:<graph-id>` and
its visible properties, in canonical order, are `state` and `layout_version`. For an accepted legacy
layer without an authored layout, `layout_version` is absent, not null.

### Relationships

`CONNECTED` represents one authored undirected GraphEdge. Its identity is `edge:<graph-id>`, its
canonical endpoints are sorted by public Content identity, and its only visible property is
`state=accepted`. One physical/public relationship is projected. Matching in either orientation
must not duplicate paths, rows, aggregates, or counts.

For row binding, consider the two possible endpoint orientations, then apply bindings established by
earlier patterns and endpoint predicates. If exactly one orientation remains, use it. If both remain,
use the orientation with the lower public Content identity at the textual left endpoint; never emit
both. This lets a query traverse outward from either constrained content vertex while an unrooted
edge scan still emits each authored edge exactly once. The returned relationship always retains
canonical `start` and `end`; a path's vertex array records a reverse traversal when applicable.

`CONTAINS` is derived from immutable layer membership. Its stable identity is
`membership:<numeric-layer-graph-id>:<zero-based-order>:<numeric-content-graph-id>` (for example,
`membership:101:0:1`). It is directed Layer to Content and has
`order`, `x`, and `y` properties in that order. `order` is the zero-based snapshot membership
position. `x` and `y` are absent for legacy coordinate-free layers; they are never synthesized.

`EXPANDS` and `REFERENCES` represent accepted navigate actions, directed from the action's source
Content to target Layer. The stable relationship identity is `action:<action-id>`. Visible
properties, in canonical order, are `source_layer_id`, `label`, `variant`, `icon`, `description`,
`relation`, and `state`; optional icon/description are absent when not authored. `relation` is the
lowercase string `expand` or `reference` matching the relationship kind. `source_layer_id` is the public
`layer:<id>` identity and is required for every node-level action. The interaction-root EXPANDS
action is also projected from its accepted interaction Content vertex to the root Layer; its
`source_layer_id` is absent because ADR 0005 defines no containing source-layer occurrence for it.

Actions are node-owned but occurrence-authored. Whenever a pattern joins
`(l:Layer)-[:CONTAINS]->(n:Content)-[:EXPANDS|REFERENCES]->(target:Layer)`, the typed plan and
lowering require the action's `source_layer_id == l.id`. A Content reused in another layer does not
make the action appear authored in that occurrence. A standalone action match may return the
relationship and its explicit `source_layer_id`, but cannot claim a containing occurrence that was
not matched. The root action can match standalone from its interaction Content vertex but cannot
match through CONTAINS.

`interaction.context` is input/control provenance, not semantic topology, and is never projected.
An unresolved invoke has no target and produces no relationship. A resolved invoke remains an
`invoke`, not an expand/reference edge; invoke/current relationships require a later, explicitly
typed contract and are absent from v1.

## 6. Property and expression semantics

Property lookup has three states: present with a value, present with null, or absent. `IS ABSENT`
and `IS NOT ABSENT` distinguish absence. Ordinary comparisons with absent or null evaluate UNKNOWN,
and WHERE keeps only TRUE. `IS NULL` is true only for present null; `IS NOT NULL` is true only for a
present non-null value. Projecting an absent property yields tagged null because absence is not a
wire value. Sorting treats both projected absence and null as null.

Comparisons require the same value type. There is no implicit integer/float, string/identity, or
boolean/numeric coercion. Integers compare mathematically as signed 64-bit values. Floats compare by
their finite IEEE-754 value after negative zero normalization. Strings and identity strings compare
by Unicode scalar value sequence. Composite values support equality and deterministic ordering but
not `<`, `<=`, `>`, or `>=` in WHERE.

`DISTINCT` compares the complete typed projected row. Grouping and DISTINCT occur before ordering;
ordering occurs before result limits. `count` returns integer. `sum` preserves integer input or
float input and fails on signed integer overflow. `avg` returns float. `min`/`max` preserve input
type. `collect` preserves deterministic pre-aggregation canonical order and returns a homogeneous
list. Null/absent inputs are omitted by all aggregates except `count(*)`; an empty `count` is zero,
while other empty aggregates return tagged null.

## 7. Tagged wire algebra

All parameters, projected values, and errors are Relayer-owned JSON. JSON object member order is not
semantic; arrays below carry every order that is semantic.

```text
null          { "type": "null" }
boolean       { "type": "boolean", "value": true|false }
integer       { "type": "integer", "value": canonical-i64-decimal-string }
float         { "type": "float", "value": finite-JSON-number }
string        { "type": "string", "value": string }
node          { "type": "node", "id": "content:<id>", "kind": "Content", "properties": fields }
layer         { "type": "layer", "id": "layer:<id>", "kind": "Layer", "properties": fields }
relationship { "type": "relationship", "id": string, "kind": relationship-kind,
               "start": vertex-id, "end": vertex-id, "directed": boolean,
               "properties": fields }
path          { "type": "path", "vertices": [node-or-layer...],
               "relationships": [relationship...] }
list          { "type": "list", "elementType": type-descriptor, "values": [value...] }
record        { "type": "record", "fields": [{ "name": string, "value": value }...] }
fields        [{ "name": string, "value": value }...]
type-descriptor = { "kind": scalar-or-graph-type }
                | { "kind": "list", "elementType": type-descriptor }
                | { "kind": "record", "fields": [{ "name": string,
                    "type": type-descriptor }...] }
```

Integer values are decimal strings so all signed 64-bit values round-trip through Rust,
TypeScript, and Python without loss. The canonical spelling is `0` or an optional `-` followed by a
nonzero digit and digits. Floats must be finite JSON numbers. NaN and infinities are rejected;
`-0.0` normalizes to `0.0`. No numeric value is string-coerced.

Lists are homogeneous recursively by exact structural `elementType`; an empty list still declares
its complete element descriptor. Record descriptors freeze ordered unique field names and each
field's recursive type, so lists of differently shaped records are heterogeneous. Records and
property field arrays have unique names and preserve declared/schema order.
Paths have `vertices.len == relationships.len + 1`, and every relationship connects adjacent
vertices in either traversal orientation. Relationship `start`/`end` are always canonical schema
direction (Layer-to-Content for CONTAINS, Content-to-Layer for actions, sorted identity for
CONNECTED) and never flip when a path is written or traversed in reverse. The surrounding vertex
order alone records traversal direction. Relationship identities in a path are unique.

A result is:

```json
{
  "queryContractVersion": 1,
  "columns": ["title"],
  "rows": [[{"type":"string","value":"Queue"}]],
  "truncated": false
}
```

Column names are unique and rows have exactly the column count. Canonical JSON for byte accounting
is UTF-8, no insignificant whitespace, object keys in the order shown by the corpus, and ordinary
JSON escaping without ASCII-only rewriting.

## 8. Deterministic ordering

Explicit `ORDER BY` applies its keys in source order. `ASC` is the default. Nulls are always LAST
unless `NULLS FIRST` or `NULLS LAST` is explicit; direction does not change that default. Ties are
broken by the canonical total order of the complete projected row, then by stable matched identity
tuples. Thus equivalent physical plans cannot reorder equal visible rows before DISTINCT/limits.

Without `ORDER BY`, rows use the canonical total order of the complete projected row followed by
the stable matched identity tuple. Value type order is:

```text
null < boolean < integer < float < string < node < layer < relationship < path < list < record
```

Within types: false precedes true; numbers use their type-specific mathematical order; strings and
identities use Unicode scalar order; vertices compare identity then canonical properties;
relationships compare kind, identity, endpoints, then properties; paths compare alternating
vertex/relationship sequences; lists compare lexicographically then by length; records compare
field names and values lexicographically then by field count. No locale, insertion order, physical
row ID, hash iteration order, or Ladybug default order is observable.

## 9. Result and execution bounds

- Without a smaller explicit `LIMIT`, at most 5 rows are returned.
- `LIMIT 0` is valid. `LIMIT` above 8 is a typed `row_limit_exceeded` error.
- The hard row maximum is 8. The effective row cap is `min(explicit-limit-or-5, 8)`.
- The canonical encoded complete result envelope may not exceed 16,384 bytes.
- There is no cursor, continuation token, or stable pagination.
- A row is never partially encoded. If a row by itself cannot fit in an otherwise empty canonical
  envelope with the result columns, return `result_row_too_large` and no rows.
- Otherwise append whole ordered rows while both caps permit. If another matched row exists but
  cannot be appended because of row or byte limits, return the complete prefix with
  `truncated=true`. A candidate beyond the effective row cap is not inspected for row oversize.
- `truncated=false` means execution established that no additional complete matched row exists.

Output limits do not bound work. Implementations independently enforce these budget dimensions:
`query_bytes`, `ast_depth`, `variables`, `pattern_parts`, `traversal_hops`, `examined_expansions`,
`intermediate_rows`, `wall_time_ms`, `cancellation`, `result_rows`, and
`encoded_result_bytes`. A request may lower a dimension but never raise the implementation maximum.
`LIMIT` affects only final rows and never relaxes traversal, expansion, intermediate-row, time, or
cancellation enforcement.

## 10. Errors and precedence

Errors use `{ "error": { "code", "phase", "path", "message" } }`; codes and phases are stable,
while message wording may add clarification without changing corrective meaning.

The precedence stages are:

1. `envelope`: malformed request, unsupported contract version, query-byte limit;
2. `parse`: lexical/syntax failure and forbidden/unsupported constructs;
3. `plan`: unknown/static/dynamic schema, type, column, traversal, variable, AST, and pattern limits;
4. `authorize`: target/permit intersection using non-oracular errors;
5. `execute`: cancellation, wall time, examined expansions, then intermediate rows, checked in that
   order at every deterministic yield boundary;
6. `normalize`: invalid engine value, heterogeneous list, integer overflow, duplicate field;
7. `encode`: oversized row and encoded-result handling.

An earlier stage wins even when a later failure also exists. Within `execute`, the listed order wins
at one yield boundary. A valid query is fully parsed/planned before target access, so syntax errors
do not become an oracle for target existence. No invalid or forbidden query reaches Ladybug.

The v1 codes are:

```text
invalid_request, unsupported_query_contract_version, query_bytes_exceeded,
query_syntax_invalid, query_construct_forbidden, query_construct_unsupported,
unknown_label, unknown_relationship_type, unknown_property, dynamic_schema_forbidden,
query_type_mismatch, duplicate_output_column, invalid_aggregate,
ast_depth_exceeded, variable_limit_exceeded, pattern_part_limit_exceeded,
traversal_limit_exceeded, row_limit_exceeded,
inaccessible_or_missing, scope_not_granted, foreign_draft,
query_cancelled, wall_time_exceeded, examined_expansions_exceeded,
intermediate_rows_exceeded, invalid_engine_value, heterogeneous_list,
integer_overflow, duplicate_record_field, result_row_too_large
```

Byte-cap prefix truncation is successful `truncated=true`, not an error. Storage unavailable,
projection-not-ready, and publication failures belong to later storage/executor contracts and must
never be translated into a stale successful result.

## 11. Compatibility and conformance

`query_contract_version` is independent of `engine_version`, `storage_format_version`,
`relayer_schema_version`, and `derived_index_version`. V1 readers reject any public request or
result with an unknown query-contract version.

Changing admitted/rejected syntax, schema names or properties, value encoding, identity,
comparison/order/aggregation semantics, error meaning/precedence, limits, authority behavior, or
path/result shape requires a new query-contract version. Adding corpus cases that merely exercise
existing rules, fixing prose to match an unchanged golden, or using a different private Ladybug
lowering does not. A lowering is contract-compatible only when every engine-neutral plan, result,
error, ordering, and budget fixture remains exact.

The v1 corpus contains:

- a manifest and checkpoint-to-case coverage inventory;
- one canonical accepted supergraph dataset with occurrence reuse and excluded action kinds;
- admitted queries with exact typed plans and results;
- rejected queries with exact code, phase, and precedence cases;
- tagged value, ordering, and limit boundary goldens.

Issue #261 must run or contract-compatibly lower this corpus against the pinned Ladybug candidate.
Issue #263 must run it against the production parser/executor. This Issue #260 lint validates only
the mechanically encoded cross-fixture invariants it explicitly checks; it does not parse the query
text, execute expected plans/results, prove every prose rule, or demonstrate Ladybug. Those proof
claims remain unavailable until their owning DAG nodes run the corpus at the real boundary.

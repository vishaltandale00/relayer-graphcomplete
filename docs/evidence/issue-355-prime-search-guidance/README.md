# Issue #355: Prime search-result cell evidence

The `query-v1` Prime guidance now reads the first exact cell from the first search row, after rejecting truncated or empty results. It verifies the tagged value and its full public layer identity before deriving the positive integer used for a typed reference target. Multiple rows remain allowed. Search-disabled and omitted profiles still receive no search guidance.

## Changed seam and checkpoints

The sole production seam is `graphSearchGuidancePython` in `packages/harness-host/src/implementations/prime-agent.ts`. The complete-Prompt test in `packages/harness-host/test/prime-agent.test.ts` observes enabled, disabled, and omitted profiles, then extracts and executes the actual emitted example. One Python subprocess covers the full envelope corpus, so this proof is of the guidance's executed Python behavior rather than source-text assertions alone.

| Checkpoint | Deterministic observation |
| --- | --- |
| Enabled prompt contains a complete extraction sequence; disabled and omitted profiles receive none | Existing complete-to-captured-prompt test, extended to assert all three profiles and extraction-before-conversion ordering |
| Truncated or missing/empty results cannot produce a target | Executed emitted Python example rejects truncated, missing rows, empty rows, and empty first row |
| Non-layer and malformed identities cannot produce a target | Executed emitted example rejects a content value, `layer:0`, and `layer:42x` |
| Valid positive identity maps exactly to an integer reference target | Executed emitted example receives two rows and yields `42` from the first cell `layer:42` |
| Search authority and reference semantics are unchanged | Existing test still checks query-v1-only guidance and the `reference` relation; production request and target-language wording are otherwise unchanged |

The affected-module manifest at `scripts/ci/affected-modules.v1.json` maps `packages/harness-host/` to `@relayer/harness-host` and its `packages/harness-host/test` Vitest checkpoint. The source and test changes are both under that mapped owner; no mapping gap was found.

## Exact emitted example exercised by the test

The test extracts this block from the prompt captured from the production harness and executes it as-is. Only `relayer_graph` and the graph response are deterministic fakes.

```python
import re
from relayer_graph import GraphSearchRequest
search = await graph.search(GraphSearchRequest(
    query="MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $title RETURN l AS layer ORDER BY layer ASC",
    parameters={"title": {"type": "string", "value": "Queue"}},
))
if search.get("truncated") is True:
    raise ValueError("Graph search results are truncated; narrow the query before selecting a layer.")
rows = search.get("rows")
if not isinstance(rows, list) or not rows:
    raise ValueError("Graph search returned no rows; no layer is available to reference.")
first_row = rows[0]
if not isinstance(first_row, list) or not first_row:
    raise ValueError("The first graph search row has no result cell to reference.")
result = first_row[0]
if not isinstance(result, dict) or result.get("type") != "layer":
    raise ValueError("The first graph search result is not a tagged layer.")
identity = result.get("id")
match = re.fullmatch(r"layer:([1-9][0-9]*)", identity) if isinstance(identity, str) else None
if match is None:
    raise ValueError("The tagged layer has an invalid public identity.")
layer_id = int(match.group(1))
```

## Envelope-to-target demonstration

| Search envelope | Outcome |
| --- | --- |
| `{"truncated": false, "rows": [[{"type": "layer", "id": "layer:42"}], [{"type": "layer", "id": "layer:43"}]]}` | First cell is `layer:42`; validated target integer is `42` |
| `{"truncated": true, "rows": [[{"type": "layer", "id": "layer:42"}]]}` | Raises the truncated-results error; no target |
| `{"truncated": false, "rows": []}` | Raises the no-rows error; no target |
| `{"truncated": false, "rows": [[{"type": "content", "id": "content:42"}]]}` | Raises the non-layer error; no target |
| `{"truncated": false, "rows": [[{"type": "layer", "id": "layer:0"}]]}` | Raises the invalid-identity error; no target |

## Verification record

The focused run used Node `v22.23.2` and Python `3.14.3`:

```text
/Users/vishal/.nvm/versions/node/v22.23.2/bin/npm exec vitest -- run packages/harness-host/test/prime-agent.test.ts
Test Files  1 passed (1)
Tests       52 passed (52)
Duration    684ms
```

The durable pre-change identity and focused test output are in `worker-pilot/evidence/factory-355/pre-change.txt` and `worker-pilot/evidence/factory-355/focused-test.txt`.

The required heavy commands ran sequentially on Node `v22.23.2`, with `CARGO_TARGET_DIR=/Volumes/2T-SSD/cargo/relayer-graphcomplete`, `CARGO_BUILD_JOBS=2`, and `RUST_TEST_THREADS=2`:

| Command | Result and inner evidence |
| --- | --- |
| `npm run check` | One initial attempt failed during Vitest: the telemetry suite raced while Electron's app bundle already existed, and the sealed Homebrew Node closure test exceeded 30 seconds. After the concurrent factory-408 Vitest run ended, Electron's install completed and resolved correctly. One unchanged full retry passed, exit 0: 172 files passed, 1 skipped; 2,267 tests passed, 3 skipped. The retry also passed the Codex secret-boundary test (2/2), Python unittest suite (29/29), Ladybug receipt checks, and PRD readability. Both full logs are retained. |
| `npm run build` | Passed, exit 0. Rust app/graph servers and all four TypeScript packages built. |
| `npm run eval:graph-memory` | Passed, exit 0. Inner result `passed: true`; test run `05f39375-7a89-4ed8-9e94-cdeeba7a7774`, case `graph-memory.prior-accepted-reference`, fixture harness `fixture-graph-memory`. |

The first check attempt's shell wrapper used zsh's read-only `status` variable, so it did not print an outer exit code. Its inner Vitest result explicitly reported 2 failed files, 170 passed, 1 skipped and the chained npm command stopped there. The retry wrapper used `result_code` and captured exit 0. No retries beyond that one were run.

Full logs are `worker-pilot/evidence/factory-355/npm-run-check.log`, `npm-run-check-retry.log`, `npm-run-build.log`, and `npm-run-eval-graph-memory.log`. The pre/post source receipts are `pre-change.txt` and `post-change.txt`. `git diff --check` passed. No paid or live inference was used.

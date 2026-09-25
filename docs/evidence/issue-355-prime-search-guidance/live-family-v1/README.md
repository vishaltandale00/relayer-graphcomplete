# Prime family live verification — issue 355 / PR 480

Source commit: `34b629ca48de11150faa02451e1780aa48f1a8bd`.
Live run: `4b0aa326-1db8-4b72-b732-2ebffeea363c`.
Treatment: `prime-family.graph-memory-delegation.v1`.

## Plan and proof boundary

Run the real Prime harness, managed Python kernel, public Python client, and Rust graph server. Use `openai/gpt-6-luna` as lead with `qwen/qwen3.8-flash` available as a native helper through OpenRouter. Require both accepted graph output and independently observed helper execution.

This supplemental treatment derives from the existing graph-memory case and changes only its case identity and second persisted user prompt, which explicitly requests one helper. Its graph assertions remain unchanged. The retained wrapper injects admitted model/access context because the stock standalone CLI does not supply it. This does not certify production provider admission, the desktop flow, the unchanged graph-memory CLI, spontaneous delegation judgment, or helper answer quality.

## What ran

- Exact-source `npm run build` passed; native Cargo build revalidated shared binaries before use. Build logs are included. Tracked source was clean and the graph binary hash remained unchanged throughout the run.
- The reviewed Prime managed runtime assembled and its real kernel readiness probe passed without inference.
- First launch `ed439999-e8e8-41bc-9858-cf101650d4e8` failed before model execution because the standalone environment lacked the host-owned Python client root. Recorded account usage change was zero. The failure log is retained.
- The corrected environment sets the exact source Python root. One subsequent live attempt completed, with both graph turns and all session/capability assertions passing.
- No product source was changed for the live treatment. No additional paid retry or model comparison was performed.

## Observed evidence

- 22 recorded root model starts identify `openai/gpt-6-luna`.
- Native child `sub-d880d125` identifies `qwen/qwen3.8-flash`, reaches `done`, reports 8,300 tokens and a reply; child duration is 26.379 seconds.
- Real Python checks truncation, rows, first row/cell, tagged layer type, and full positive-decimal identity before converting `layer:1` to integer `1`.
- Authoritative graph audit: first submit acknowledgement 24; one bounded parameterized search 32; typed reference targeting that searched layer 35; final successful acknowledgement 38.
- A missing root action rejected submission 36. Luna added the root expansion action and succeeded; this was not an error-free run.
- Trace elapsed time: 151.377 seconds. Observed key/account usage increased by $0.010381005. This is an account-level observation, not independently reconciled per-request billing, and may be affected by concurrent activity or accounting delay. Prime's zero cost fields are unknown-cost sentinels.

## Review and remaining limitations

Reviewer `/root/prime_live_review_plan` independently reviewed exact source above and wrapper SHA-256 `fea9b4a3af1d3b54542c54d1a603526b3bf2293df98b451504a8bf37642ff590`. Verdict: PASS for supplemental live extraction/reference behavior and actual Luna/Qwen execution.

Luna obtained the helper reply from its completed session log. Clean native reply delivery was not established. The adapter expects child status `completed` for terminal stream handling while the observed native event uses `done`; native child completion was corroborated, but trace-stream terminal classification is imperfect. The non-Codex session-continuity assertion compares equal nonempty persisted state and misleadingly labels it fixture identity; it is not a Prime-specific identity assertion. These limitations remain unresolved by this evidence-only publication.

The private raw trace includes a child transcript dump and is deliberately withheld. `selected-trace.ndjson` retains selected root route/usage events, the helper launch and terminal metadata, and real graph search/extraction/submission evidence with source event indexes. It omits private transcript dumps and their derivative provider events. `select-evidence.py.txt` records the selection procedure; the raw trace digest remains in `summary.json`. No API key is included.

`result.json` holds the graph checks and authoritative audit. `identity.json` binds source, built artifacts, managed recipe, models and configuration. `case-treatment.json` binds the original and derived case. Driver sources are retained as `.txt` evidence and are not repository entry points.

The four `historical/` logs are the previously referenced deterministic check attempts, build and fixture graph-memory run from PR 480. They are historical evidence and do not certify this supplemental live run or a newer source snapshot.

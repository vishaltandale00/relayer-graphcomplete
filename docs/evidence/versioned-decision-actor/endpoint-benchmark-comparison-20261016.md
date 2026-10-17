# Judge-gated multi-turn comparison

Both actors reached judge-reported completion. Decisions exercised the repaired boundary: incomplete judgment → ordinary-user follow-up → third accepted candidate response → complete judgment. The original unfinished stop was permitted by behavior v7; the separate optional prompt v11/behavior v8 benchmark requires judge approval for normal completion. Historical/default revisions remain unchanged.

Live source: `ff6c3a436b7ae43b2f61c98d5d121bbbed3f10835c81cb56b69ab1e76a121395`. Later browser-test-only source: `0d1162a406f983e9d5b5e9b0a7eaa9f1971b2b35f846ab9bb0d0b9fcb151c62e`; production bytes are identical. Full raw bindings, phase measurements and usage audits are in [the JSON report](endpoint-benchmark-comparison-20261016.json).

| Measure | Native Codex | Decisions + Codex text |
| --- | ---: | ---: |
| Accepted candidate responses | 2 | 3 |
| Accepted follow-ups | 1 | 2 |
| Actor operations | 3 | 12 |
| Task execution wall time | 97.959 s | 130.038 s |
| Simulator inference time | 18.734 s | 27.394 s |
| Decisions selection time | — | 6.884 s / 12 calls |
| Codex text time | included above | 20.302 s / 5 calls |
| Candidate attempt time | 70.081 s | 73.856 s |
| Completion judge time | 6.665 s / 1 call | 14.390 s / 2 calls |
| Simulator API-rate proxy | $0.008928 | $0.041884 |
| Judge API-rate proxy | $0.050048 | $0.073544 |
| Candidate API-rate proxy | $0.033681 | $0.032692 |
| Combined API-rate proxy | $0.092657 | $0.148120 |
| Final judge verdict | Complete | Complete |

Native supplied all private choices in one accepted composer follow-up. Both candidate `submittedInputs` arrays are empty; no structured-input consumption is claimed for that arm. Its second response visibly includes the window, Canary, both signals, and a rule to roll back unless both remain healthy. The judge approved its first finish proposal.

Decisions filled the window, accumulated Health metrics and Synthetic checks through the authored controls, and sent its choices with Canary in composer text. The second response consumed the text and multi-select attachments, but deferred rollback to a decision process. The judge rejected this finish as incomplete. The actor continued and sent an explicit condition: immediately pause Canary and roll back if either selected signal fails during validation. The third accepted response visibly incorporated that condition and obtained approval. No failed or exhausted trajectory was discarded and no stochastic outcome was retried.

In this pair Decisions used twelve operations versus three and five native text generations. Its selector averaged 0.574 s per call, but extra navigation, text generation and judge recovery outweighed that fast selection. Task execution was 32.7% longer; simulator cost proxy was 4.69× native. This run provides no end-to-end latency or cost saving. It does not isolate per-operation inference efficiency because the actors and stochastic candidates took different paths.

The same case, private brief, endpoint wording, actor model/effort, candidate Luna/medium configuration, Sol/high judge, six-response cap, sixty-action cap and fifteen-minute deadline were pinned for both. Temporal features were disabled, so this exercises ordinary between-response Send rather than working-completion live Answer. The pair is native-first, single-repetition and on a shared host. Matching judge policy and approval is stronger than comparing complete against incomplete, but does not establish deterministic endpoint equivalence, identical answer quality or a general causal advantage.

Both final plans leave numeric thresholds unspecified. The pinned endpoint says “concrete rollback trigger” without expressly requiring numeric thresholds; this judge accepted categorical signal failure conditions, whereas the preceding pair demanded concrete thresholds. That semantic/calibration limitation remains unresolved. These fictional plans do not establish deployment readiness.

All fifteen actor screenshots match their event artifact hashes; twelve have stable before/after presentation identities. Native's final capture is stable (`a5b4d0baf1c322e898148e89a9f0a984d53bb7349810e463eeeb979a5be21e62`). Decisions' actual final actor capture (`2969e941c015af003a9c2299c9c01e2f38720354384971dace632e36203fe150`) visibly shows the revised condition, and its after-capture identity is accepted turn5/attempt5/node36; the presentation changed from turn4 during capture. That original actor observation is not a stable bracket. Any post-run read-only corroboration is recorded separately and cannot retroactively change it.

Task execution wall time covers task creation/start through actor completion, including startup and candidate work, excluding subsequent exports. Actor/browser/candidate durations overlap and must not be summed. Hybrid selector/text durations nest inside actor duration. Cost figures use terminal cumulative native session snapshots independently matched to rollout logs, plus summed independent Decisions requests; candidate usage is the last total per unique provider thread across exports. Hybrid simulator proxy includes $0.020397 Decisions base usage for 203,967 input tokens. Native subscription invoices are unavailable: API-rate equivalents are estimates, with tier/regional/context adjustments unestablished. Pricing sources and all raw hashes are in the JSON.

Required verification, failures and non-certifying review are recorded separately in [implementation evidence](endpoint-benchmark-20261016.md). The earlier unequal-endpoint results remain preserved in [the preceding report](multiturn-input-comparison-20261016.md).

A separate read-only production ReviewSession subsequently reopened exact accepted turn5/attempt5/layer11/node36. Its final screenshot and accepted thread detail were stable before/after capture; no provider execution or browser write occurred, and historical task/audit/result files remained hash-identical. This corroborates persisted final content without replacing the unstable original actor observation. Its script, screenshot metadata and receipt are retained in the live root’s `post-run-review` directory and hash-bound from the JSON report.

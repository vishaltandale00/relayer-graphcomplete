# Multi-turn comparison after selection and delivery correction

Both actors delivered follow-ups and saw later accepted responses. Native reached the fictional task endpoint; Decisions stopped honestly with one requirement unresolved. This fixes the observed selection/reset and pre-Send delivery failures without forcing a participant to continue.

Source: `c119733bcec08022dd403a773bd894f75d81087d7df9aa88bb9f4e403257bb47` (`actor-inputs-source-20261016.json`). Both isolated experimental roots use prompt v10, behavior v7 and observation v4; the hybrid pins Decisions execution v2. Defaults and historical revisions remain unchanged. The full measurements and receipts are in [the JSON report](multiturn-input-comparison-20261016.json).

| Measure | Native Codex | Decisions + Codex text |
| --- | ---: | ---: |
| Accepted candidate responses | 4 | 3 |
| Accepted follow-up submissions | 3 | 2 |
| Actor operations | 13 | 7 |
| Actor inference time | 57.717 s | 15.310 s |
| Decisions selection portion | — | 3.208 s / 7 calls |
| Codex text portion | included above | 12.064 s / 3 calls |
| Total task wall time | 204.087 s | 98.633 s |
| Actor cost, API-rate equivalent | $0.029630 | $0.019124 |
| Completion-judge inference time | 16.549 s / 2 calls | 7.207 s / 1 call |
| Completion-judge cost, API-rate equivalent | $0.081130 | $0.026331 |
| Candidate cost, API-rate equivalent | $0.048006 | $0.029026 |
| Final endpoint assessment | Complete | Incomplete |

Native first sent a redundant question, then supplied the exact window, Canary and both validation signals through accepted input attachments. Its initial resulting plan lacked concrete rollback thresholds. The completion judge declined the proposed endpoint; the actor sent another follow-up and inspected the fourth response, which proposed explicit automatic thresholds. Those thresholds are fictional operational defaults requiring service-owner approval, not deployment execution.

Decisions supplied the window, clicked Send, selected Health metrics then Synthetic checks, supplied Canary in a short follow-up, and clicked Send again. The combined signal attachment was admitted and consumed by the third response. The final plan visibly applies all private choices, but leaves thresholds unspecified and says to roll back if needed. The actor stopped `satisfied` with `endpointStatus: incomplete`; the completion judge also reported incomplete. This was a permitted unfinished stop after delivery, not the previous pre-Send failure. No additional stochastic trajectory was run to turn that outcome into success.

The final screenshot for each arm was visually inspected and matches a stable accepted response identity before and after capture. Native screenshot SHA-256: `2ebaf6ec94ff92cfff92df687bc4cf212c7f058e8adc5c3a6ad2e9106315ae68`; Decisions: `8874dd01088dcc1ecccc28b584b01baaa68fe39a2ae2b1c473f64e0c2738d096`. All 20 actor screenshots are hash-bound to observation events; 17 captures have unchanged surrounding presentation identities. Only the stable final captures establish the final visible-incorporation assertion. Candidate `submittedInputs` separately verifies consumption; typed drafts or actor/judge claims alone do not establish delivery.

The pair preserves the same case definition, private brief, candidate `codex-basic` configuration, Luna/medium model settings, disabled temporal features, four-response cap, sixty-action cap and fifteen-minute deadline. Actor settings match except for the explicit Decisions execution field. This tests between-response Send, not working-completion live Answer. Graph authoring remains candidate-owned; actor operations are visible navigation/input actions, not graph mutation tools.

The two trajectories differ in candidate content, turn count, final completeness and judge calls. One native-first pair on a shared macOS host, with other jobs and a finishing compiled-runtime check, cannot establish a causal matched-endpoint latency or cost advantage. Actor/browser/candidate durations overlap; nested selector/text times must not be added again. Native figures use standard API-rate equivalents because subscription invoices are unavailable. Hybrid actor cost includes $0.0082812 base Decisions API usage for 82,812 input tokens plus the Codex text proxy. Long-context, tier and regional adjustments are not established.

Native SDK usage is the terminal cumulative snapshot per simulator or judge session, independently matched to its native rollout. Candidate usage uses the last total per unique provider thread across exports. Independent Decisions HTTP usage is summed. Pricing sources and raw file hashes are retained in the JSON report.

The earlier failed hybrid pilot is preserved in [the pilot report](multiturn-input-pilot-20261016.md). Required verification and its failures/unknowns are recorded separately in [the implementation evidence](actor-inputs-20261016.md). Review is non-certifying without a PR.

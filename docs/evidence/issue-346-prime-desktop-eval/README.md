# Prime/OpenRouter Desktop Eval — verification plan

This change covers the Prime/OpenRouter development portion of #346. It does not
complete Claude Eval support, packaged installation qualification, or release proof.
PR #480 remains unproven through Desktop Eval until the live receipt below exists.
The prior supplemental standalone run is not Desktop Eval evidence.

## Product promises and changed seams

Authority: PRD §9.1–9.4 (ordinary persistent product executions, read-only review,
and bounded candidate evidence), §13.1 (Desktop Eval uses real product identities),
ADR 0006 (native provider recursion and provider-neutral product boundaries).
The explicit #346 acceptance criteria require product provider/model discovery,
credential separation, executable admission, native runtime execution, and live proof.

| Changed seam / checkpoint | Deterministic observation | Heavy or live evidence due |
| --- | --- | --- |
| Explicit development profile loading; malformed input must not expose keys | `eval-prime-provider.test.mjs` profile parsing and sanitized errors | Saved profile/artifact exact-key scan |
| Production provider composition with encrypted credentials and execution leases | Provider integration tests plus existing provider composition/secret-boundary tests | Actual connected OpenRouter route through desktop |
| Exact lead and helper roster; no fallback on missing models, failed admission, changed roster, or changed key | `eval-prime-provider.test.mjs`; `eval-service-simulated-user.test.mjs` two-turn pinning | Product execution identity and admitted model plan |
| Managed Prime assembly/readiness; initial unavailable state and no ambient fallback | Managed runtime tests; targeted Eval runtime tests | Managed composite probe and actual confined kernel execution |
| Unconnected Prime is disabled in Eval and rejected before thread creation | `eval-service-simulated-user.test.mjs` | Desktop unavailable-state screenshot |
| Existing Codex provisioning preserves connected Prime definitions | `eval-managed-codex-runtime.test.mjs` | Full deterministic check |
| Provider shutdown follows graph runtime cleanup, including failed startup | Provider lifecycle tests and runtime teardown tests | Desktop shutdown/reopen with persisted run |
| Original natural graph-memory case through ordinary product workflow | Existing graph-memory checks and Eval integration tests | Two accepted turns, query-v1 result → typed reference, Product workspace screenshot |

No tests are retired. Existing provider/runtime tests protect their own production
boundaries; new tests protect Eval composition and admission rather than replacing them.
Unmapped integration/lifecycle behavior requires the full `npm run check` fallback.

## Required commands and live context

Before commit: `npm run check`, `npm run build`. Tests use no paid inference.
Run the original `graph-memory.prior-accepted-reference` case in the actual
`desktop/eval-main/index.mjs` Electron app using `prime-agent-basic` and the
deterministic graph-contract judge. Do not edit the case prompt to force helpers.
Actual Flash delegation is a separate observed claim, not a condition of graph-memory.

Development opt-in: set `RELAYER_EVAL_PRIME_PROFILE_FILE` to an existing private
live-run configuration file. `RELAYER_EVAL_PRIME_PROFILE` defaults to
`prime-openrouter`. The selected entry requires OpenRouter auth, `modelId`, and
`verificationHelperModelId`; the first model leads, the second is available to
native Prime recursion. The credential is held in the normal encrypted provider
store. A different supplied key or changed family requires a fresh Eval profile;
there is no silent credential/model replacement. Set `RELAYER_EVAL_USER_DATA_DIR`
to an isolated persistent directory. Never commit these credentials or user-data.

The user authorized the focused live run using the existing OpenRouter key and
its $50 account-key limit. This is not a per-run spending cap. The intended pair
is `openai/gpt-6-luna` → `qwen/qwen3.8-flash`.

## Results

Implementation and deterministic verification are in progress. No Desktop Eval
pass, screenshot, persistent graph, or final adversarial approval is claimed yet.
Record exact source commit/digest, runtime recipe/receipt, run/thread/interaction
identities, model plan, checkpoint outcomes, costs and retained graph location
when those observations exist. Preserve failed attempts and unresolved limits.

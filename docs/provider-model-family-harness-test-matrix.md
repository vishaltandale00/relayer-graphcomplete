# Provider, model-family, and harness test matrix

## Status and purpose

This document defines the target product test matrix for moving from provider selection to a ready question composer in Relayer Desktop. It records the strict provider-to-harness decision confirmed on 2026-08-30 and separates deterministic product checks, live API-provider checks, and manual managed-subscription checks.

This is the test specification for the provider-family flows now owned by PRD section 2. It is not proof that the current implementation passes. The PRD remains authoritative for product meaning. In particular:

- agent setup is separate from work-context selection;
- onboarding does not require the user to choose or configure a harness;
- Model is the primary composer control and Advanced may change the harness only before thread creation;
- a submitted thread pins its harness while later interactions may change model; and
- raw provider credentials never enter product records, logs, graph content, exports, screenshots, or evidence manifests.

### Remaining PRD reconciliation blockers

The target matrix still includes two product decisions that the current PRD does not fully authorize:

1. PRD `AGT-004` and section 2.1 enable Codex and API-key login methods, but this matrix includes a managed Claude subscription path.
2. PRD sections 2.1 and 17 describe Prime Agent as a development or partial clean-install target, while this matrix defines its intended availability and live execution cells.

These rows are target acceptance criteria and remain `Blocked` for product certification until the PRD is explicitly reconciled. ADR 0006 establishes the provider-agnostic harness boundary and reviewed harness configurations, but it does not override these delivery-status statements in the PRD.

## Target product contract

### Strict provider-to-harness availability

`Available` means the harness may appear after the provider has a connected credential, an eligible discovered model, an enabled family containing that model, and the required execution-access contract. `Unavailable` means the harness must not be offered for that provider/model selection; a stale or forced request must fail explicitly before inference.

| Provider adapter | Credential path | Default harness | Codex Basic | Claude Basic | Prime Agent Basic |
| --- | --- | --- | --- | --- | --- |
| Codex subscription | Managed browser authentication | Codex Basic | Available | Unavailable | Unavailable |
| Claude subscription | Managed browser authentication | Claude Basic | Unavailable | Available | Unavailable |
| OpenAI API | API key | Codex Basic | Available | Unavailable | Available in Advanced |
| Anthropic API | API key | Claude Basic | Unavailable | Available | Available in Advanced |
| OpenRouter | API key | Prime Agent Basic | Unavailable | Unavailable | Available |
| Vercel AI Gateway | API key | Prime Agent Basic | Unavailable | Unavailable | Available |

Decisions enforced by this table:

- Codex Basic supports only the Codex subscription and direct OpenAI API adapter.
- Claude Basic supports only the Claude subscription and direct Anthropic API adapter.
- Prime Agent supports API-key adapters in this slice.
- Subscription-backed Prime execution stays unavailable until a specific adapter, lifecycle contract, and live proof are accepted.
- OpenRouter and Vercel being OpenAI-protocol-compatible does not make them Codex Basic providers in this slice.
- Prime Agent Basic is the only Prime configuration in this QA matrix. Prime Agent Deep is intentionally out of scope; this document makes no product-catalog removal decision.

### One product-managed, provider-scoped family per connection

Every successfully connected provider definition with at least one eligible model must project one enabled product-managed, provider-scoped model family without requiring the user to build a custom family. Relayer product policy owns this family; provider adapters supply catalog facts and execution-eligibility classifications but do not own family lifecycle or defaults. A connected provider with zero eligible models creates no enabled family and enters the explicit recovery state below.

The family contract is:

1. The family belongs to one provider definition, not merely to an adapter type. Two OpenAI connections receive two distinct families.
2. It contains only models eligible for text/agent execution through at least one allowed harness in the strict table.
3. It contains at most five models under the versioned eligibility and ordering policy below. Relayer must not infer `latest` from a model ID.
4. Catalog refresh updates the product-managed family deterministically while preserving historical interaction receipts.
5. Custom families remain user-owned and are never rewritten by product-managed-family refresh.
6. A removed or newly ineligible selected model remains visible as unavailable where history or a preserved draft needs it; Relayer never silently substitutes another model into that draft.
7. Only the first successfully onboarded provider may supply the default provider, family, harness, and initial model as one valid configuration.
8. A provider added through Settings creates its product-managed family but does not replace the existing defaults or any preserved composer draft.

#### Eligibility and ordering policy

This policy is versioned as `provider-default-family/v1` and is owned by PRD section 2.1.

1. Each code-owned adapter classifier returns `eligible` or `ineligible` with a stable reason code for every catalog entry.
2. A model is eligible only when authoritative metadata identifies ordinary synchronous text or agent execution, or a reviewed adapter classifier admits it using frozen catalog fixtures. Unknown capability metadata fails closed.
3. OpenAI API family V1 first admits the reviewed current agent aliases in this order when present: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and `gpt-5.4`. This prevents legacy `/models` catalog order from making an old, tool-incompatible model the automatic Codex default.
4. After the reviewed roster, the family selects provider-declared eligible defaults and then remaining eligible models in provider order; the family is truncated after five members. Unreviewed IDs, dates, price, and names do not otherwise influence ordering.
5. On refresh, an eligible selected model remains selected even if its position changes. If it becomes ineligible or disappears, a preserved draft shows it as unavailable and blocks Send; no substitute is committed without an explicit user choice.
6. Zero eligible models is a stable recoverable state. The credential may be saved as connected, but no enabled family is created. Onboarding cannot finish and shows `provider_no_eligible_execution_models`. Settings addition preserves existing defaults and points to refresh, endpoint, or provider recovery. A later eligible refresh creates the family under the same provider definition.
7. OpenRouter family V1 contains only the reviewed general-agent roster `deepseek/deepseek-v4-pro-0813`, `qwen/qwen3.8-max`, and `z-ai/glm-5.3`, in that order. Missing or unavailable entries are omitted; unrelated provider-default or catalog-first models do not fill the family.
8. Vercel AI Gateway family V1 contains the equivalent reviewed roster using Vercel catalog identities: `deepseek/deepseek-v4-pro-0813`, `alibaba/qwen3.8-max`, and `zai/glm-5.3`, in that order. It has the same fail-closed omission behavior.

The deterministic fixtures must include embeddings, moderation, speech recognition, text-to-speech, image-generation-only, realtime-only, batch-only, malformed entries, unknown capability metadata, duplicate IDs, multiple declared defaults, no declared default, and zero eligible models. A successful `/models` response alone does not make every returned ID executable.

## User-flow matrix

Every provider row must pass both Flow A and Flow B. Managed subscriptions are manual-only because they depend on interactive vendor browser authentication and account state.

### Flow A: first-run onboarding

```text
Clean isolated profile
→ choose provider
→ enter API key or complete managed sign-in
→ connect and discover models
→ Relayer creates the product-managed, provider-scoped family
→ Relayer selects the provider's default harness and initial model
→ optional Relayer-account step is resolved
→ New Thread opens with a ready composer
→ ask a question
→ accepted graph and exact execution receipt appear
```

Acceptance checkpoints:

- The credential form uses `Connection name`, not a misleading editable provider identity.
- API endpoints are prefilled for known adapters and remain validation-gated.
- Connect verifies authentication and model discovery without invoking Complete.
- Onboarding does not require family construction or harness selection.
- The composer displays the resolved family and model; Advanced displays exactly the harnesses allowed by the strict table.
- Submit is enabled only when the provider, credential, family, model, harness, and permission profile form a valid configuration.
- The first interaction records the exact provider definition, model, family, harness configuration revision, and permission receipt.
- The harness must finish through `graph.submit(interactionNode)`; a model turn ending is not completion.

### Flow B: add a provider through Settings

```text
Existing usable profile
→ Settings
→ Providers
→ Add provider
→ enter API key or complete managed sign-in
→ connect and discover models
→ Relayer creates the new product-managed, provider-scoped family
→ existing defaults remain unchanged
→ return to New Thread
→ select the new family
→ verify the allowed Advanced harness choices
→ ask a question
→ accepted graph and exact execution receipt appear
```

Acceptance checkpoints:

- The new provider and product-managed family are usable immediately; no separate custom-family workflow is required.
- Adding a provider never silently changes the saved default provider, family, harness, or model.
- The family/model picker can select the new provider's product-managed family.
- Incompatible harnesses are absent. A stale client request for one is rejected before inference with a user-facing error.
- Existing threads do not gain a harness switch. The new harness selection applies only to a new thread.

## Provider test cases

| ID | Provider | Required flows | Execution cells | Test mode |
| --- | --- | --- | --- | --- |
| PFH-CODEX-SUB | Codex subscription | Onboarding and Settings | Codex Basic | Manual managed-subscription test |
| PFH-CLAUDE-SUB | Claude subscription | Onboarding and Settings | Claude Basic | Manual managed-subscription test |
| PFH-OPENAI | OpenAI API | Onboarding and Settings | Codex Basic, Prime Agent Basic | Deterministic adapter/UI tests plus authorized live API test |
| PFH-ANTHROPIC | Anthropic API | Onboarding and Settings | Claude Basic, Prime Agent Basic | Deterministic adapter/UI tests plus authorized live API test |
| PFH-OPENROUTER | OpenRouter | Onboarding and Settings | Prime Agent Basic | Deterministic adapter/UI tests plus authorized live API test |
| PFH-VERCEL | Vercel AI Gateway | Onboarding and Settings | Prime Agent Basic | Deterministic adapter/UI tests plus authorized live API test |

There are 18 provider/harness combinations: 8 supported cells and 10 unsupported cells. Running both flows produces 36 flow cells: 16 supported and 20 unsupported. The canonical result identity is `(providerAdapter, harnessId, flow, verificationLayer)`.

Every unsupported flow cell requires deterministic availability and forced-request rejection coverage, including a harness/provider invocation count of zero. Every supported API-key flow cell requires a live execution when authorized: six combinations across two flows, or 12 L1 executions. The two supported managed-subscription combinations across two flows require four M1 flow-cell results containing at least ten accepted interactions under the lifecycle checklist.

### Complete 36-flow-cell ledger

`Supported` means complete a question and prove accepted execution. `Rejected` means prove the harness is absent and a forced stale request is rejected before inference. Each onboarding and Settings entry is a distinct result.

| Provider | Harness | Onboarding | Settings addition | Required positive layer |
| --- | --- | --- | --- | --- |
| Codex subscription | Codex Basic | Supported | Supported | M1 manual |
| Codex subscription | Claude Basic | Rejected | Rejected | D1 + D2 |
| Codex subscription | Prime Agent Basic | Rejected | Rejected | D1 + D2 |
| Claude subscription | Codex Basic | Rejected | Rejected | D1 + D2 |
| Claude subscription | Claude Basic | Supported | Supported | M1 manual |
| Claude subscription | Prime Agent Basic | Rejected | Rejected | D1 + D2 |
| OpenAI API | Codex Basic | Supported | Supported | D1 + D2 + L1 |
| OpenAI API | Claude Basic | Rejected | Rejected | D1 + D2 |
| OpenAI API | Prime Agent Basic | Supported | Supported | D1 + D2 + L1 |
| Anthropic API | Codex Basic | Rejected | Rejected | D1 + D2 |
| Anthropic API | Claude Basic | Supported | Supported | D1 + D2 + L1 |
| Anthropic API | Prime Agent Basic | Supported | Supported | D1 + D2 + L1 |
| OpenRouter | Codex Basic | Rejected | Rejected | D1 + D2 |
| OpenRouter | Claude Basic | Rejected | Rejected | D1 + D2 |
| OpenRouter | Prime Agent Basic | Supported | Supported | D1 + D2 + L1 |
| Vercel AI Gateway | Codex Basic | Rejected | Rejected | D1 + D2 |
| Vercel AI Gateway | Claude Basic | Rejected | Rejected | D1 + D2 |
| Vercel AI Gateway | Prime Agent Basic | Supported | Supported | D1 + D2 + L1 |

## Model-family cases

### Required single-provider families

For each provider connection with at least one eligible model:

- verify automatic creation, name, kind, enabled state, and owning provider identity;
- verify one to five eligible models in authoritative order;
- verify the selected initial model is available and executable by the default harness;
- verify ineligible catalog entries are absent from ordinary selection;
- verify refresh, reorder from provider data, model removal, and empty-eligible-roster behavior; and
- verify a second connection using the same adapter gets an independent family and credential reference.

### Required custom-family cases

Custom-family behavior remains part of the product and must be tested separately from automatic product-managed, provider-scoped families:

| Case | Members | Expected harness behavior |
| --- | --- | --- |
| Codex-compatible API family | Direct OpenAI API models only | Codex Basic and Prime configurations may appear |
| Claude-compatible API family | Direct Anthropic API models only | Claude Basic and Prime configurations may appear |
| Prime multi-provider family | OpenAI API + Anthropic API + OpenRouter + Vercel | Prime configurations may use the admitted API roster. Codex and Claude are absent or reject the selected incompatible model; Relayer never silently substitutes a different family member. |
| Same-adapter, two-connection family | Models from two independent OpenAI definitions | Provider identity and credential acquisition remain distinct |
| Deliberately incompatible family | Only models disallowed by the selected harness | Harness absent or explicit pre-inference error; no silent fallback |
| Stale family | Selected member removed or credentials revoked | Draft preserved, Send blocked, recovery points to the owning provider/family |

## Harness and picker checkpoints

For each provider and family state:

1. Model is the primary tab and immediately precedes Submit.
2. Advanced shows only harnesses allowed by the strict provider table and currently usable by the selected family/model.
3. Switching a compatible harness preserves the current family/model when still compatible.
4. Switching to a harness that needs a different family must not silently rewrite the model-primary choice. The incompatible harness stays absent or the attempted selection is rejected until the user explicitly chooses a compatible model. Any automatic-switch UX requires its own product decision and deterministic rendered test.
5. A click that starts inside the picker cannot become an outside click after re-render detaches its target.
6. A genuine outside click, Escape, and focus return behave correctly.
7. Async catalog refresh or validation cannot commit a stale request or silently dismiss an error.
8. The new thread persists the selected harness once; follow-ups render it read-only.
9. A follow-up may select another compatible model and preserves all prior receipts.
10. Permission-profile availability is recomputed for the selected harness before send.

## Connection, failure, and recovery cases

Each API-key adapter requires deterministic and live checks for:

- masked secret entry and paste;
- missing, malformed, rejected, and revoked credentials;
- valid and invalid endpoint overrides;
- transport failure, timeout, malformed JSON, empty catalog, and duplicate model IDs;
- cancel before connection settles and late completion after cancellation;
- explicit catalog refresh and background/pre-inference refresh;
- rename, a second independent connection, removal, and removal blocked while default-owned;
- restart recognition without secret leakage; and
- credential deletion when provider removal reaches its terminal state.

Each managed-subscription adapter requires the manual checklist below plus deterministic fake-runtime coverage for equivalent lifecycle transitions.

## Manual managed-subscription checklist

Run Codex and Claude subscription cases separately in clean isolated profiles. Do not reuse an API-key connection as evidence for a subscription path.

Record tester, date, platform, app source commit, app version, managed-runtime version, native harness configuration ID and revision, permission-profile ID and revision, isolated profile identifier, provider adapter, discovered model IDs, selected family/model, selected harness, interaction ID, execution-attempt ID, terminal state, and evidence artifact paths. Never record tokens, cookies, authorization codes, environment variables, Keychain values, raw auth responses, or provider session data.

### Manual onboarding

- [ ] Start with a clean isolated profile.
- [ ] Select the managed subscription provider.
- [ ] Use the exact `Connect Codex` or proposed `Connect Claude` action to start browser authentication; record the rendered label.
- [ ] Cancel once and verify the app remains recoverable.
- [ ] Let one browser attempt time out, then verify a stale or duplicate completion cannot connect the wrong attempt. If vendor timing makes this impractical, cite the exact D1 fake-runtime case instead.
- [ ] Start again and complete authentication in the browser.
- [ ] Verify the app, not the authorization page, reports the connected account.
- [ ] Verify model discovery and the product-managed, provider-scoped family.
- [ ] Verify only the subscription's native harness is available.
- [ ] Force each unsupported harness request and verify a stable pre-inference rejection, zero provider requests, and rendered recovery.
- [ ] Resolve the optional Relayer-account step without blocking local use.
- [ ] Verify New Thread opens with a valid selected family/model.
- [ ] Ask one minimal question and verify an accepted graph plus exact receipt.
- [ ] Ask a second question and verify session continuity, pinned harness revision, permission receipt, and accepted completion.
- [ ] Restart the app and verify connection, family, defaults, thread, receipt, and graph restore.
- [ ] After restart, start a new thread and complete a new interaction; restore-only evidence is insufficient.
- [ ] Capture checkpoint-specific redacted evidence rather than one final screenshot.

### Manual Settings addition and recovery

- [ ] Begin from a different already-usable provider profile.
- [ ] Add the managed subscription from Settings.
- [ ] Complete authentication and verify a distinct provider definition and product-managed family.
- [ ] Verify existing defaults do not change.
- [ ] Start a new thread, select the new family, and verify only the native harness appears.
- [ ] Ask one minimal question and verify an accepted graph plus exact receipt.
- [ ] Use the exact Relayer `Disconnect` action rendered for the provider and record its label (`Disconnect` is the current Codex PRD label; any provider-qualified label such as `Disconnect Claude` requires PRD/UI acceptance). Verify projects, threads, graphs, families, and historical receipts remain. This disconnects Relayer's provider reference; it is not evidence of vendor-wide logout or token revocation.
- [ ] Verify new sends using that provider are blocked with a recovery action.
- [ ] Reconnect and explicitly refresh the catalog; verify the preserved family becomes usable again without duplication.
- [ ] Complete a new interaction after reconnect and verify a new execution attempt and receipt.
- [ ] If practical in the vendor test account, exercise expired or revoked authentication and verify the same recovery boundary.
- [ ] Capture checkpoint-specific redacted evidence, including disconnect, blocked send, reconnect, refresh, and accepted execution.

An observed failed connection, restore, or execution checkpoint is `Fail`. The managed-subscription result is `Indeterminate`, not `Pass`, when the evidence is missing or ambiguous—for example, browser completion is visible but the app's connected state or terminal execution state was not captured.

## Verification layers

### D1: deterministic in-process checks

Default suite; no paid inference and no external authentication.

- adapter catalog normalization and execution eligibility;
- strict provider/harness rules and access contracts;
- product-managed, provider-scoped family creation and refresh;
- product persistence and pre-send validation;
- picker availability, selection, dismissal, async request ordering, and errors;
- forced unsupported-combination rejection; and
- secret redaction and credential-reference-only persistence.

### D2: deterministic development-app checks

Use the real Electron renderer, Rust app server, SQLite store, production adapter composition, and deterministic local provider servers. Exercise both onboarding and Settings addition through rendered controls. No paid inference.

### Current executable mapping

The present deterministic portfolio is partial:

```sh
npx vitest run test/provider-adapters.test.mjs test/provider-onboarding-ipc.test.mjs test/provider-onboarding-model.test.mjs test/provider-ui.test.mjs test/model-family-settings.test.mjs test/model-picker-model.test.mjs test/model-picker-ui.test.mjs
cargo test -p relayer-app-server --test model_catalog_flow
npm run evidence:provider-ux
npm run evidence:model-selector
```

The Vitest and Rust commands are D1 seams. `evidence:provider-ux` and `evidence:model-selector` are partial D2 captures; neither enumerates all 36 flow cells. `npm run evidence:prime-family:packaged` is a separate heavy packaged-app runner and is due only in its declared clean-install/release context.

No current command maps all 36 flow cells to independently visible results, fixtures, reset boundaries, timeouts, stable error codes, request counts, and artifacts. A future deterministic D2 entry point such as `npm run evidence:provider-harness-matrix` is therefore a required but currently undefined mapping gap, not a command that may be claimed as run.

### L1: authorized live API-provider checks

Use isolated provider definitions and the real API-provider catalogs. Run one minimal accepted interaction through every supported API-key provider/harness cell. Record actual model IDs because live catalogs drift. Keep API keys in the operating-system credential store and out of commands and evidence.

### M1: manual managed-subscription checks

Use the checklist above for Codex and Claude. Browser authentication and provider account state make these cases manual. Fake-runtime deterministic tests remain necessary but cannot replace M1.

## Evidence and reporting

Every run report must separate the planned matrix, commands or manual procedure actually run, and observed results. A test name, outer exit code, browser authorization page, or successful catalog request is not execution proof.

For each matrix cell record:

- source commit or working-tree digest;
- provider adapter and opaque provider-definition ID;
- family ID/revision and exact non-secret model IDs;
- harness configuration ID/revision;
- flow (`onboarding` or `settings`);
- verification layer (`D1`, `D2`, `L1`, or `M1`);
- result (`Pass`, `Fail`, `Blocked`, `Indeterminate`, or `Not run`);
- exact checkpoint reached and terminal error when applicable;
- stable error code, harness/provider invocation count, and either the execution-attempt ID/state or an explicit `no attempt created` observation; and
- redacted screenshot, artifact digest, manifest, interaction receipt, and accepted-graph reference when required.

Evidence requirements vary by cell:

| Cell outcome | Minimum evidence |
| --- | --- |
| Supported execution | Ready composer, exact selected identities, execution-attempt state, accepted graph, receipt, request count, and artifact digest |
| Unsupported combination | Harness absent or stable rendered rejection, forced-request result, either `no attempt created` or an exact rejected/pre-inference attempt state, and harness/provider invocation count `0` |
| Connected with zero eligible models | Connected state, `provider_no_eligible_execution_models`, blocked onboarding or preserved Settings defaults, request count, and recovery action |

Before retention, evidence must be scanned across enumerated surfaces: renderer screenshots, stdout/stderr, app-server logs, test-server request captures, SQLite/product exports, graph payloads, receipts, manifests, and artifact metadata. The redaction scanner, corpus, and command are not yet defined; this is an explicit verification mapping gap. Live evidence must state whether inference was invoked and which cells incurred it.

### Result semantics

- `Pass`: every checkpoint for the exact result identity was observed on the recorded source snapshot.
- `Fail`: the product reached the case and violated at least one required checkpoint.
- `Blocked`: a prerequisite outside the tested product path was unavailable, including missing authorization, unresolved PRD authority, unavailable vendor account, or unavailable runtime.
- `Indeterminate`: the run started but evidence cannot distinguish pass from failure, an inner scenario result is missing, or the terminal state is ambiguous.
- `Not run`: no attempt was made.

Missing live-test authorization is `Blocked` or `Not run`, not a product failure. A zero-eligible catalog is a `Pass` only when the explicit error, preservation, zero-inference, and recovery checkpoints all pass.

## Exit criteria

The provider-to-question experience is ready only when:

1. All 36 flow cells have D1 and D2 results: 72 layer-by-flow-by-cell results, with no required result `Fail`, `Indeterminate`, or `Not run` and every `Blocked` item explicitly resolved before certification.
2. Every provider connection automatically projects a valid product-managed, provider-scoped family or gives `provider_no_eligible_execution_models` with the specified preservation and recovery behavior.
3. For every provider with at least one eligible model, both onboarding and Settings addition reach a ready composer without mandatory family construction or harness configuration. Zero-eligible cases instead pass the explicit blocked-onboarding or preserved-Settings recovery contract.
4. All 12 supported API-key flow executions pass L1 with authorization: six provider/harness combinations across onboarding and Settings.
5. All four supported managed-subscription flow-cell results pass M1 manually and contain at least ten accepted interactions total: onboarding first, follow-up, and post-restart interactions plus Settings first and post-reconnect interactions for both Codex and Claude.
6. No unsupported harness is offered or reaches inference.
7. No non-executable catalog model is ordinarily selectable.
8. No credential appears in product data, graph data, chat history, exports, screenshots, manifests, or logs.
9. Known failures and unrun cells remain explicit; no partial matrix is reported as complete.

## Current implementation gaps observed before this matrix

These observations are diagnostic inputs, not completion claims:

- API-key providers now automatically receive a product-managed, provider-scoped family when the discovered catalog contains eligible models.
- Codex Basic and Claude Basic now reject OpenRouter and Vercel; Prime Agent Basic is the tested router route.
- API adapters now classify discovered execution eligibility from provider metadata and fail closed when capability evidence is unknown.
- Managed Codex and Claude subscription paths still require the manual M1 run.
- The default-harness/default-family Settings interaction needs a separate explicit UX decision; this matrix does not authorize silent family replacement.
- The PRD reconciliation, complete 36-cell D2 runner, and evidence-redaction checker are still undefined certification blockers.

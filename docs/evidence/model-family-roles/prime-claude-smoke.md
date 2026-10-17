# Prime and Claude role-family trial — 2026-10-08

The user explicitly requested live trials with Prime and Claude after the Codex
smoke. These opt-in trials use the unchanged combined producer/consumer/picker
source from `live-smoke.md`. They exercise the production GraphComplete runtime,
app server, model-family validation, provider admission, and native harnesses.
They do not qualify desktop onboarding or encrypted credential persistence.

## Plan and executable seams

The checkpoints remain those in `docs/contracts/harness-model-family-roles.md`:
exact V2 role admission, model-visible roster, native root/specialist execution,
and product-owned accepted/failed outcomes. Trial drivers are ignored local
artifacts; no production implementation changed. Syntax checks preceded execution.
No default test performs paid inference. The previous deterministic results,
including the full-check failure and downstream unrun gates, remain as recorded
in `live-smoke.md`; they were not converted into passes or repeated here.

The production managed-runtime installer validated the pinned
`claude@0.3.286` and reviewed `prime@0.8.1` recipes. No compatible local
installation was found in the inspected profiles/cache locations. Installation
used the recipe's integrity-checked archives and Prime reviewed tree copier,
then exact local recipe validation. No cold native Rust build was needed.

Existing API keys were supplied through memory-only execution leases. They were
not written into trial profiles or evidence. Inherited provider keys were removed
before native/tool subprocess launch. Claude used an isolated config directory.

## Actual outcomes

| Trial | Requested family | Outcome |
| --- | --- | --- |
| Claude + Anthropic API | Haiku 5.5 orchestrator, Sonnet 5.5 implementation, Opus 5.5 review | Failed: native API HTTP 400 billing error, insufficient credits |
| Prime + Anthropic API | Same Anthropic family | Failed: native API HTTP 400 invalid request, insufficient credits |
| Prime + OpenAI API | GPT-5.6-Luna orchestrator, GPT-5.6-Sol implementation, GPT-5.5 review | Accepted; both designated native children actually ran |

Both original Anthropic attempts were admitted but ended `execution_failed` with
**unknown** effect boundaries. No native delegation/tool calls were observed.
They are not pre-admission failures and do not prove Claude specialist routing.
Prime's native provider performed two rejected requests within its one attempt.
The pinned Claude executable's read-only auth status reported no existing
subscription login. The user was offered subscription sign-in or API funding;
no billing transaction or new credential connection was performed.

The OpenAI Prime trial settled in 121,177 ms. Product interaction 1, graph node
21, and its attempt are **accepted**, without completion error, with
`graph_write`. The V2 admission binds the three exact models and roles above,
including descriptions. Root native assistant records use `gpt-5.6-luna`.
Actual child assistant records use `gpt-5.6-sol` and `gpt-5.5`; both native
`parentSession` values identify root `01a11e17-b0f4-71b3-9176-6bc1ebb99305`.
Declared graph labels alone were not used as model-routing proof.

The accepted Prime graph correctly explains that the original filter removes
`NaN` and supplies `const unique = xs => [...new Set(xs)]`. It omits the explicitly
requested orchestrator name from response nodes 22–26; admission/native evidence
independently supplies that identity. This remains a small prompted routing
smoke, not a task-quality or cost-parity certification. Native zero price values
are unknown-cost transport sentinels, not evidence of free inference.

## Durable local artifacts and source binding

Artifacts are under `.relayer/evidence/family-roster-picker/harness-live/`:

- `anthropic-failures.json`, `claude-smoke.json`, `prime-smoke.json`, and original
  private profiles retain both failures, admitted plans, and native billing errors.
- `anthropic-trial-driver.mjs`: original reviewed driver SHA-256
  `e5a2ceda5a726c4f4e8f91bc7f94d2e5828c7dcedd64bd6d0083429ab2ec39bf`.
- `prime-openai/prime-smoke.json`: accepted trial and matching pre/post execution
  identities; SHA-256
  `1c529282222051ee2d19c62444e59edd63e66f6fc577459e18f4b1770b5a9969`.
- `prime-openai/prime-prelaunch.json`: source and compiled/runtime bundle identity
  captured before inference. Trial workspace digest is
  `a68310e7d2153778be6082210868badc2cc4ba28299a8e376b0b072a95a5dadb`.
- `prime-openai/native-proof.json`: original native file hashes, exact assistant
  models, parentage, per-call usage, and read-only product admission/acceptance.
- `prime-openai/prime-trace/`: exported complete candidate trace and graph-operation
  artifacts. Coverage is interpreted from the actual manifest, not inferred from
  an outer successful command.
- OpenAI driver `.relayer/harness-role-openai-live.mjs`: SHA-256
  `37663f1ce83570e95f53c43a6aa6f3e52fda3a6eaeb7f90894487811abce3a05`.
  The ignored driver identity is recorded separately from repository provenance.

## Adversarial assertion

Reviewer `/root/roster_picker_review` reviewed both exact driver hashes and
independently checked original Anthropic native failures and product outcomes.
Claude smoke artifact SHA-256 is
`ed1425d65ef4d9da454cffbd3e9878e0bee82d5a74f0af7ac573c4950cbf6658`;
Prime Anthropic artifact SHA-256 is
`6ed7fe40a7988f7bcfce8754e746778a0d329abb4abcd7ff1debcf32c806e747`.

For the OpenAI artifact hash and workspace digest above, the reviewer independently
verified V2 roles, product acceptance, actual native root/child models and
parentage, and the correct NaN explanation. Verdict: one successful Prime native
routing smoke is supported. Unresolved: omitted orchestrator label in the output,
Claude blocked by billing/authentication, and quality/cost/Desktop qualification
not established. No paid rerun was performed by the reviewer. Without a PR this
is a **non-certifying handoff review**.

## Claude subscription follow-up — 2026-10-08

The user clarified that Claude should use subscription access, completed the
normal desktop sign-in, and authorized the existing live trial. This follow-up
supersedes the Claude authentication blocker above; both earlier API billing
failures remain recorded. No production implementation changed.

The actual desktop connected a Claude subscription provider, saved a family with
`fable` as orchestrator, `sonnet` as implementation, and `opus` as review, then
sent the same small uniqueness-function task through Claude Basic. Product
interaction 2 and attempt 1 are **accepted**, without a completion error, with
`graph_write`. The admitted V2 family uses `claude-subscription` and
`managed-runtime@1`. Six response nodes were accepted, and the accepted graph was
visually inspected in the desktop.

Native root assistant records identify `claude-fable-5-1`. Its native `Agent`
calls requested `sonnet` and `opus`; the actual child assistant records identify
`claude-sonnet-5-5` and `claude-opus-5-5`. Both sidechains share root session
`76dac92f-c72d-43d1-906c-d58e299c59a6`. This routing claim uses native records,
not the generated graph's model labels.

Sonnet incorrectly described the original function's NaN behavior and Set's
signed-zero representation. Opus identified the correct behavior; Fable caught
both errors and produced the correct accepted synthesis with
`const unique = xs => [...new Set(xs)]`. A remaining instruction-following issue:
the native specialist responses contain 105 and 103 whitespace-delimited words,
despite the requested limit below 100 and the synthesis's claim that both complied.

Required proof was subscription admission, actual native root/child routing,
product acceptance, and visible desktop settlement. All were observed in this
one trial. It does not establish autonomous delegation policy, quality/cost
parity, arbitrary cross-provider routing, or permanently pinned model aliases.
The earlier deterministic full-check failure and unrun gates remain unchanged.

Artifacts under `harness-live/claude-subscription/` include `prelaunch.json`,
`postlaunch.json`, `smoke.json`, copied native JSONL records, and `result.png`.
The production managed-runtime installer validated `claude@0.3.286`. Source,
compiled bundle, and runtime identities matched before and after the trial.
Prelaunch source was dirty commit
`6bd48c58cac50b0be2aa9a1d36c9db82916b0be5`, workspace digest
`sha256:56927a588cd4114cc00c0960e03e6128422b3302a37b979db2980183baad5beb`.
This evidence-only addendum follows that tested snapshot.

SHA-256 identities:

- Prelaunch artifact:
  `761159547a7028dc7b6decef3c02690c83c83eccbab11844b0b6145179496f25`.
- Smoke artifact:
  `0ed8cced103d0809b6a1e8941da01988af4d6621a5231046824f42404911bfe3`.
- Native root:
  `bf4238e03b7c531732f914f93ca4ef9ecb8808a1ebd3cf3b7f3151f4a6996017`.
- Native Sonnet child:
  `430b40d60a9d878df3d664beeabdb0dc8cc8704bdfa0e2decf801c65e378974b`.
- Native Opus child:
  `d2c9fda4fc89dd007a1b1b3d883cf57cf56b761de6054ea62ff10743d9d0e4f4`.

Reviewer `/root/roster_picker_review` independently inspected the exact prelaunch
artifact, original native records, and product SQLite outcome for this workspace
digest. Reviewed scope: V2 roles, subscription admission, native parentage and
actual models, graph acceptance, and the bounded quality observations above.
Verdict: one successful Claude subscription routing smoke is supported.
Unresolved: specialist word limits, autonomous-policy and quality/cost claims,
and broader qualification. The reviewer performed no inference. Without a PR,
this is a **non-certifying handoff review**.

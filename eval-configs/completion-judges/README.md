# Completion judge revisions

These YAML files define endpoint completion review. Graph-presentation grading has its own judge configs. The filename is the prompt version; publication binds the exact file bytes, evidence contract, model settings and motivating human feedback. Reload the setup panel after editing a file.

`completion-judge-v1.yaml` and `completion-judge-v2.yaml` use native Codex review. Native bootstrap defaults remain unchanged. Existing tasks keep their original revision pins.

`completion-judge-v3-decisions.yaml` is an optional hybrid:

- `settings.decision` pins the OpenAI Decisions connection, GPT-6 Luna and `openai-decisions-completion-judge-v1` execution contract. Set `providerId` to the connected OpenAI API ID displayed in Eval Settings or the setup panel.
- `settings.model` and `settings.modelReasoningEffort` configure the native Codex writer for the evidence explanation and ordinary-user continuation hint. Both routes must be available before a candidate starts. Eval Settings manages credentials; the YAML contains the provider ID.
- Decisions selects complete, incomplete or uncertain. Codex receives that selected verdict and a schema allowing only it. Refusals, malformed answers, changed verdicts, failures and cancellation never become approval or native fallback.
- Selector and reporter stages retain separate usage and request identities. Their requests reconstruct from the original bounded packet and screenshot, plus the recorded question, selected verdict, prompt and schema. Selector usage is per request; native usage is cumulative within its session.

To use it, edit the provider ID, reload Setup revisions, choose a completion-judge predecessor and this config file, select motivating feedback, and publish. Select that revision for a new simulated task, or explicitly publish an evaluator release containing it. Publishing starts no inference and promotes no default. API-backed actors or completion judges are excluded from subscription-only external tasks.

The integration is fixture-tested separately from model calibration. It establishes no latency, cost or quality advantage. Verification and checkpoint mapping live in `docs/evidence/versioned-decision-actor/completion-judge-20261016.md`.

# Harness Settings usability evidence

`harnesses.png` is a deterministic, inference-free capture of the real desktop
renderer driven by `scripts/capture-provider-ux-video.mjs`.

The fixture deliberately keeps both `codex-basic` and `claude-basic` runtime
configurations in the backend catalog while projecting only Codex as exactly
usable through the currently connected providers, available models, enabled
families, model rules, and execution-access contract. The image demonstrates:

- only the usable Codex harness appears in the ordinary list;
- the ordinary card contains only its user-facing name and saved-default status;
- the saved default is identified without a redundant Available badge;
- no model-rule editor or Advanced configuration entry point is exposed from
  this screen; and
- installed configurations that are not currently usable remain omitted.

The capture is 1280×800, 28,794 bytes, with SHA-256
`fa1db8553a5e80b494c0db71c0482c3aaff8ec1ecc898c4217643fce1cbed877`.

# Harness Settings usability evidence

`harnesses.png` is a deterministic, inference-free capture of the real desktop
renderer driven by `scripts/capture-provider-ux-video.mjs`.

The fixture deliberately keeps both `codex-basic` and `claude-basic` runtime
configurations in the backend catalog while projecting only Codex as exactly
usable through the currently connected providers, available models, enabled
families, model rules, and execution-access contract. The image demonstrates:

- only the usable Codex harness appears in the ordinary list;
- the ordinary card contains only its user-facing name, saved-default status,
  and Advanced configuration action;
- the saved default is identified without a redundant Available badge;
- raw adapter rules remain behind the keyboard-native Advanced configuration
  action; and
- the separate Configure other harnesses action preserves access to advanced
  rule editing for installed configurations omitted from the ordinary list.

The capture is 1280×800, 39,899 bytes, with SHA-256
`5dde3accb695c009d966b0a2c926ef3f1c1d2d040447091f4a5a219e79308e60`.

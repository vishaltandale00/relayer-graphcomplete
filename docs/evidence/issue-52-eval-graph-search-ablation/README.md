# Desktop Eval graph-search ablation

`preset-selected.jpg` is a credential-free rendered acceptance capture of the
production Eval renderer assets. The fixture supplies only the catalog and run
list APIs; it does not replace renderer markup, styles, selection behavior, or
the `createRun` selection reader.

The operator opened **New test run** and selected **Graph search · query-v1**.
The rendered controls then contained exactly:

- case: `graph-memory.prior-accepted-reference`;
- Codex control and `query-v1` treatment;
- Claude control and `query-v1` treatment;
- Prime Agent control and `query-v1` treatment; and
- judge: `deterministic-graph-contract`.

The deterministic companion test is
`test/eval-graph-search-ablation.test.mjs`. It binds the production controller,
clicks the preset, and verifies the exact selection passed to `createRun`.

This capture proves the visible configuration and selection boundary. It does
not prove live provider inference, search quality, or a packaged Prime Agent
runtime. Those runs remain opt-in and metered.

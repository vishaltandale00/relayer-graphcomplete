# Conversation export to Eval evidence

These screenshots are opt-in, zero-inference visual evidence for GitHub issue #105. They use the
real Relayer Eval dashboard, Rust product and graph stores, the conversation importer, and the
production `ProductWorkspace` renderer in read-only review mode.

Run:

```sh
npm run build
RELAYER_CAPTURE_CONVERSATION_EVAL_EVIDENCE=1 electron scripts/capture-conversation-eval-evidence.mjs
```

`manifest.json` records the capture command, zero paid inference calls, screenshot hashes, and the
visible requirement mapped to each image. Screenshots prove only rendered visible state and
navigation. The deterministic default E2E test proves exact ordinary export bytes, contract and
exclusion checks, import publication, judging eligibility, process restart, hostile imports, ID
remapping, and mutation/action rejection. The Electron workflow also restarts graph, product, and
Eval services, then reopens the same judged import and reference path in ProductWorkspace.

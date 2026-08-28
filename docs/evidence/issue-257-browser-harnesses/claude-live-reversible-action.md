## Live reversible-action proof addendum

This addendum closes the issue #257 evidence gap for the shipped `claude.basic` route at source head `bdf088e8b60341c016478700f56cc851ee3b2c71`.

- Runtime: `@anthropic-ai/claude-agent-sdk@0.3.250`, Claude Code `2.1.250`, Chrome `152.0.7977.42`, macOS arm64.
- Operator setup: an already-running Chrome instance exposed loopback CDP from a dedicated temporary non-default profile. A local non-secret test page and its benign marker existed before the Claude SDK MCP handler ran.
- Route: the actual SDK `tool` / `createSdkMcpServer` registration wrapped the production `createClaudeBasicBrowserServer` handler. No model call or paid inference was used.
- Observation: the handler read the pre-seeded marker and initial test value.
- Reversible action: separate valid calls filled the test value from `before` to `changed`, observed `changed`, filled it back to `before`, and observed the restored value.
- Cleanup: each tool call completed and closed its own CDP connection; the Chrome endpoint and proof page remained reachable afterward.

Sanitized receipt:

```json
{
  "markerSha256": "9eb08e5b8c2221b12438ed3bfc0f9af8e1bfa6f96f7d4947a25db04eb63d9690",
  "initialValueSha256": "6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb",
  "changedValueSha256": "d67e2e944994496c8d8ec76eed0cf9f09679448d584b532bebf941852a37f5ed",
  "restoredValueSha256": "6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb",
  "preseededMarkerObserved": true,
  "sdkMcpHandlerInvoked": true,
  "reversibleActionObserved": true,
  "reversibleActionRestored": true,
  "chromeAliveAfterCleanup": true
}
```

No cookies, credentials, private URLs, page bodies, tab inventories, screenshots, profile bytes, or unrelated content were retained.

# Contributing

Relayer GraphComplete is pre-alpha. Open an issue before making a large architectural change.

## Development rules

- Keep Prime Agent runtime behavior out of graph policy.
- Prefer prompt-enforced content judgment over deterministic content heuristics.
- Keep deterministic checks for graph integrity, authority, lifecycle, and budgets.
- Add focused tests for every behavior change.
- Do not use paid model calls in the default test suite.

Run before opening a pull request:

```sh
npm run check
npm run build
```


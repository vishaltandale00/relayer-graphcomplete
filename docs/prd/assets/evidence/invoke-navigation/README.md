# Issue #114 invoke-navigation evidence

These screenshots come from the real production Electron workspace, Rust product server,
Rust graph server, and the deterministic `fixture-task-system` harness. The harness makes
zero inference calls. Its test-only file gate holds the leased interaction in `running`
until the disabled source action has been captured; normal fixture runs do not wait.

Regenerate from the repository root after `npm run build`:

```sh
RELAYER_INVOKE_EVIDENCE_DIR="$PWD/docs/prd/assets/evidence/invoke-navigation" \
  ./node_modules/.bin/electron scripts/test-desktop-first-message.mjs
```

| Evidence | Verified state |
| --- | --- |
| `01-unresolved.png` | Product source turn before invocation; the selected invoke action is available. |
| `02-running-disabled.png` | Product source turn while its leased result is running; the same action is disabled. |
| `03-resolved.png` | Product source turn after acceptance; the same action is available as resolved navigation. |
| `04-cross-interaction-destination.png` | Product follows the resolved action to the accepted result interaction and its root layer. |
| `05-revisited-source.png` | Product workspace history returns to the source turn with the resolved action intact. |
| `06-eval-cross-interaction-destination.png` | Read-only Eval follows the same resolved action to the same accepted result behavior. |

The capture script validates the corresponding durable action target, interaction statuses,
visible control state, turn identity, Product history, and Eval read-only mode before writing
each frame. The PNGs were visually inspected after generation; they are implementation
evidence, not design mocks.

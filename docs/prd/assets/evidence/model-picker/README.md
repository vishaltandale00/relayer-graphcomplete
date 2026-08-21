# Issue #34 verification evidence

These captures come from the real Electron product renderer backed by the real Rust app server and SQLite store. The capture workflow performs live, account-aware Codex `account/read` and paginated `model/list` discovery. It registers the deterministic task-system fixture under the `codex.basic` implementation key for completion, so the two accepted interactions make zero paid inference calls.

Run the opt-in workflow after `npm run build`:

```sh
npm run evidence:model-selector
```

The machine-readable [manifest](./manifest.json) records the discovered catalog, pinned harness, per-interaction model receipts, capture-to-requirement mapping, and zero-inference disclosure.

## Product evidence

| PRD requirement | Evidence |
| --- | --- |
| Model is immediately left of Submit; Folder and Permissions remain separate on the left | [dark new-thread Model](./dark-new-thread-model.png), [light new-thread Model](./light-new-thread-model.png) |
| The picker chooses family, then an available model | [dark new-thread Model](./dark-new-thread-model.png) shows the live Codex family capped at five connector-ordered models |
| Advanced is a tab inside the Model picker | [dark new-thread Advanced](./dark-new-thread-advanced.png) |
| A user may select a harness before thread creation | [dark new-thread Advanced](./dark-new-thread-advanced.png) shows both shipped Codex Basic harnesses |
| The harness is pinned after creation | [dark nth-turn Advanced](./dark-nth-turn-advanced.png) shows the read-only Codex Basic harness |
| Follow-ups inherit the previous selection and may change model | [dark nth-turn Model](./dark-nth-turn-model.png) and the manifest show turn 1 on `gpt-5.6-sol` and turn 2 on `gpt-5.6-terra` |
| Accepted interactions retain their model identity | [dark nth-turn Model](./dark-nth-turn-model.png) shows `Codex · GPT-5.6-Terra` in the interaction banner |
| Dark and light appearances remain legible | [dark new-thread Model](./dark-new-thread-model.png), [light new-thread Model](./light-new-thread-model.png), [dark Settings](../model-settings/dark-defaults-and-system-family.jpg), [light Settings](../model-settings/light-defaults-and-system-family.jpg) |
| Settings has only Harness and Provider under Defaults | [dark Settings](../model-settings/dark-defaults-and-system-family.jpg), [light Settings](../model-settings/light-defaults-and-system-family.jpg) |
| Model families use one-family-per-viewport horizontal scrolling, with inline creation | [dark Settings](../model-settings/dark-defaults-and-system-family.jpg), [narrow New family](../model-settings/narrow-new-family-editor.jpg), plus the focused family-settings tests |

## Deterministic verification coverage

| Contract | Automated evidence |
| --- | --- |
| Connector order, hidden-model retention, metadata preservation, pagination, no inferred latest, and every required refresh trigger | `test/model-catalog.test.mjs` |
| System-family cap of five; custom-family validation, explicit ordering, cross-provider identities, copied system families, and unavailable default-harness diagnostics | `test/model-family-settings.test.mjs`, `crates/relayer-app-server/tests/model_catalog_flow.rs` |
| Only enabled families and currently available compatible models enter chat; empty states block send and route to Settings | `test/model-picker-model.test.mjs`, `test/model-picker-ui.test.mjs` |
| A zero-model candidate harness rolls back the entire selection with `No available models for this harness` | `test/model-picker-model.test.mjs` |
| Keyboard tabs/options, Escape focus return, outside-click dismissal, narrow layout, and light theme | `test/model-picker-ui.test.mjs` |
| Product payloads carry only `harnessId` and model identities; follow-ups never submit a raw harness configuration | `test/model-picker-ui.test.mjs`, Rust product-flow tests |
| SQLite persistence, final-send revalidation, per-interaction runtime transport, follow-up inheritance/override, execution receipts, and atomic action-source inheritance | `crates/relayer-app-server/tests/product_persistence_flow.rs` |
| First-message product flow accepts a graph without paid inference | `test/first-message-composer-integration.test.mjs` |

Approval-prompt lifecycle remains Issue #54. An ongoing per-interaction approval-profile selector remains Issue #58. They are related acceptance contracts, not dependencies of Issue #34; this feature preserves the existing new-thread Permissions control without folding it into the Model picker.

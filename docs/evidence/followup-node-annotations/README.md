# Follow-up node annotations: A → B

PRD §7.1 promises a permanent `+` on every selectable node, with editable and confirmable annotations during generation. This proof uses real Electron, Rust product/graph storage, and a deterministic harness fixture. It spends no paid inference.

The selected node belongs to the second accepted interaction, a follow-up titled “Refine the queue ordering.” A third interaction remains running throughout the comparison and confirmation. Both sides use the same persisted backend state. A temporarily overlays only the pre-fix `workspace.js` from commit `70d2d5fad590b75c7903358a0f4805026647cd76` into a copied renderer. B restores the fixed renderer. This isolates the renderer regression; it is not a comparison of two complete historical application binaries.

| Capture | Observed result |
| --- | --- |
| [A: before](A-before-missing-plus.png) | Selected follow-up node has no `+`. |
| [B: after](B-after-plus-visible.png) | Same selected occurrence has an enabled `+`. |
| [C: editor](C-after-editor.png) | Annotation text can be entered while the next follow-up runs. |
| [D: confirmed](D-after-confirmed.png) | One confirmed attachment appears in the composer. |

The runner reads the real context-draft API after confirmation, verifies the annotation and exact source interaction/layer/node, reloads Electron, and checks the attachment restores while generation continues. The receipt binds raw PNGs, pre-fix/fixed renderer bytes, capture script, and runtime binaries. The PNGs are unmodified captures and were visually inspected.

## Reproduce

After `npm run build`, with the checkout's native binaries available at `target/debug`:

```sh
RELAYER_ANNOTATION_EVIDENCE_DIRECTORY=docs/evidence/followup-node-annotations node --input-type=module -e '
import { runElectronProof } from "./scripts/electron-proof-process.mjs";
await runElectronProof({
  executable: "./node_modules/.bin/electron",
  script: "scripts/capture-followup-node-annotations.mjs",
  label: "Follow-up annotation evidence",
  resultVariable: "RELAYER_ANNOTATION_EVIDENCE_RESULT",
  profileVariable: "RELAYER_ANNOTATION_EVIDENCE_PROFILE",
});
'
npx vitest run test/followup-annotation-evidence.test.mjs
```

The baseline commit must be available locally. `RELAYER_ANNOTATION_BASELINE` can select another explicit baseline for a new comparison. Regeneration changes the receipt and PNG hashes; inspect the images before committing. The parent owns Chromium storage through process exit and requires a positive result written after service/fixture cleanup. The capture permits 60 seconds for service startup; it does not certify standard startup latency.

## Checkpoint mapping and limits

- `workspace-followup-annotations.test.mjs` observes visible controls, editor/confirmation/discard, exact occurrence, read-only denial, running Send lock, and Send-request freeze through `createProductWorkspace`.
- `followup-annotation-evidence.test.mjs` rejects stale capture-script or fixed-renderer bytes, changed PNGs, and missing confirmation/provenance checkpoints.
- The real graph test `interaction_context_accepts_published_current_before_turn_completion` covers accepted temporal publication before graph completion, unpublished rejection, old-publication retention, wrong-source denial, and transfer to the next interaction.
- Product persistence `confirming_a_node_context_draft_revalidates_and_replays_one_annotation` covers confirmation while the source follow-up is running, canonical snapshot validation, replay, and reopen.

The visual fixture shows an accepted follow-up while another follow-up runs. It does not visually demonstrate a temporal intermediate layer of the still-running source completion; the real graph and HTTP tests cover that separate boundary. Receipt checks validate the recorded evidence, not a fresh GUI execution. Full check/build, required desktop runners, review, and hosted merge checks are reported separately in the PR.

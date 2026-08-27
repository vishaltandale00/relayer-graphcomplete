# Issue 174: packaged Prime family evidence

This evidence run uses the exact packaged Relayer application, its production renderer, Rust app and graph servers, Node harness host, production `prime-agent-basic` harness, and active `openai-api` adapter. The only deterministic component is a local HTTPS server that implements the OpenAI `/models` and `/responses` protocol. It performs no paid inference and is not packaged into Relayer.

## Prerequisite

Issue 173 must be integrated first. The verifier fails closed unless the supplied `Resources/app.asar` contains the production Prime harness host implementation and Prime runtime, and the adjacent packaged resources contain `harnesses/prime-agent-basic.yaml`. It never injects a fixture adapter or harness and never enables a release configuration override.

## Run

On macOS, build or install the exact candidate and run:

```sh
npm run evidence:prime-family:packaged -- \
  --app /absolute/path/to/Relayer.app \
	--prime-source /absolute/path/to/prime-agent \
  --output /absolute/path/to/issue-174-evidence
```

`--prime-source` must be the clean checkout at the exact commit recorded in the packaged Prime manifest; the command fails closed on any commit mismatch and executes the upstream model, tool, lifecycle, and bounded-kernel regression suites from that checkout. `ffmpeg`, `ffprobe`, and `openssl` must be on `PATH`. Add `--keep-profile` only while diagnosing a failed run. The test certificate is trusted only by the spawned evidence process through `NODE_EXTRA_CA_CERTS`; the production app bundle is not modified.

## Required proof

The run starts with a clean profile whose app-default harness is incompatible with the connected provider, then records the user's explicit Prime harness, custom family, and root-model choices. It requires a root request for `relayer-evidence-root`, a native recursive request for the second family member `relayer-evidence-child`, an accepted graph, a follow-up rooted at the second model in the same Prime session, process restart and persisted-thread resume, and a stale draft blocked after model revocation.

Before opening the app, the command also runs focused deterministic Prime integration assertions for the three-model/two-adapter roster, two isolated definitions sharing `openai-api`, complete upfront credential resolution, outsider rejection, session reuse, and the #71 Ask/Auto/Full authority contract. Their names and source/output hashes are recorded in `prime-contract-matrix.json` and aggregated into the main manifest; they are not repeated in the video.

The output includes `manifest.json`, `prime-contract-matrix.json`, milestone PNG screenshots, `prime-family-packaged.mp4`, a poster, decoded first/middle/last playback frames, and a packaged-app log. The manifest hashes the exact ASAR and every media artifact, records sanitized model requests and session IDs, and rejects accidental inclusion of the API credential. The video is validated as H.264 with `yuv420p` pixel format, decoded again, and rejected unless its representative frames are distinct.

Generated evidence is intentionally not checked into the repository. Attach the complete output directory to the issue or PR and review both the manifest assertions and first/middle/last video frames before accepting the proof.

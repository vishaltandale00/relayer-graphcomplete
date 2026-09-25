## Purpose

This temporary draft PR exists only to run the bounded CI cancellation experiment for issue #407 on a real PR whose diff includes the reviewed Rust changes from issue #356. Do not merge this PR.

## Exact source and scope

- Workflow/cancellation source: reviewed issue #407 commit `e17fea2f27d570dec7c564e93b8d6975602a48ca` (PR #478).
- Rust source: reviewed issue #356 commit `d693d3b168ba5c33d45c315d46534f9b81865e90` (PR #481), applied as its exact diff from `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`.
- Combined candidate: `2db633c42734524ac7267b0c3f7ec90081b2af6b`, tree `19bf24a33787f0e640fb18ab5f2dbef73389b496`.
- The combined `.github/workflows/ci.yml` blob is byte-identical to PR #478's workflow blob `f2c37df5e7202a6340b22c8934a206f3cac96be8`.

## Local gates

- `npm run check`: passed after one unchanged retry using external `TMPDIR`; the first run exhausted local Data-volume space during temp Mach-O sealing and produced two timing-sensitive assertions. The only retry passed: 2,268 tests passed, 3 skipped.
- `npm run build`: passed.
- The combined tree is not claimed to be PR #478's exact reviewed source tree or to have additional product correctness claims beyond those gates.

## Hosted experiment

After this draft PR's bootstrap run is canceled and terminal, two empty commits with this exact tree will be pushed sequentially to the PR branch. Run A must show selected Rust jobs pending or active before run B is pushed. Manual bootstrap/B cancellation is cleanup only and is never evidence of supersession.

The experiment tests the unchanged #407 workflow on a combined tree with real Rust changes. It is not execution on #407's exact tree. The paired pushes themselves do not modify Rust files; the open PR contains the reviewed #356 Rust diff. Results and limitations will be added after receipt capture. No merge is intended.

# Issue 353 project-row New Thread evidence

The [demo video](project-new-thread-demo.mp4) shows three production-renderer states captured by the deterministic Electron scenario:

1. the resting project row without a thread count;
2. the row with its trailing New Thread action revealed by pointer hover; and
3. the existing New Thread composer focused, draft-preserving, and scoped to that project.

The video is assembled from the scenario's direct `webContents.capturePage()` outputs. It uses no prototype imagery or paid inference. The [poster](project-new-thread-poster.png) shows the activated state.

Run `npm run test:desktop:project-new-thread` to reproduce the source captures under `.relayer/evidence/project-new-thread/`.

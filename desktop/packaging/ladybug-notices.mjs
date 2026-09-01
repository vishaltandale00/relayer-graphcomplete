import { resolve } from "node:path";

// Single authority for where the vendored Ladybug notices live in the repository
// and where they are bundled inside a packaged application. The native-receipt
// verifier, both electron-builder configs, and the pack-time notice check must
// all derive these from here rather than hand-syncing the same literals.
export const LADYBUG_NOTICES_REPO_ROOT = "vendor/ladybug/notices";
export const LADYBUG_NOTICES_BUNDLE_DIR = "notices/ladybug";

export function ladybugNoticesExtraResource(repositoryRoot) {
  return {
    from: resolve(repositoryRoot, LADYBUG_NOTICES_REPO_ROOT),
    to: LADYBUG_NOTICES_BUNDLE_DIR,
  };
}

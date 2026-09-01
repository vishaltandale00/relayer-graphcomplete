# Visual assets

`@relayer/visual-assets` is the deterministic library/tool seam for logical visual assets. Callers discover registries, root tags, one tag layer, and scoped assets through the `VisualAssetsLibrary` interface. They add only harness-provided file handles and receive logical asset objects; generic content records and digest deduplication remain private to the Module.

Project queries include project-associated assets plus assets associated with authorized project threads. A query narrowed to a project-attached thread includes project assets and that thread's assets. Those threads share the project tag tree; projectless threads own separate tag trees.

Asset bytes are immutable in v1. Organization and scope associations may change, and archival removes user assets from ordinary discovery without invalidating their accepted digest references. Public downloads resolve one logical `assetId`; digest-only lookup remains an internal persistence concern. System registries can keep content and default relationships read-only while allowing user-created associations and tag relationships.

V1 supports JPEG, PNG, and SVG. `add` fully decodes JPEG and PNG bytes with the maintained Sharp decoder before atomically indexing content and creating the logical object. SVG is fully parsed with the maintained strict SAX parser and a fail-closed element, attribute, reference, and CSS allowlist. AVIF, GIF, and WebP are rejected as unsupported in V1 rather than accepted from header probes. `inspect` resolves, validates, and digest-verifies content before returning a frozen file-backed preview; unavailable or corrupt content fails explicitly.

Discovery order is deterministic. A continuation cursor is bound to its explicit query scope, canonical tag context, sort, and the library revision at which its page was issued. If addition, archival, association, or tag reorganization changes the inventory before the next page, continuation fails with `page_snapshot_stale`; callers restart the query instead of receiving a page that may duplicate or skip entries. An operation that leaves observable inventory unchanged does not advance the revision or stale a cursor.

`initialAssets` is a validated bootstrap/catalog seam for deterministic fixtures and process reopen handoff, not durable persistence. Every initial asset must provide bytes and passes the same media, length, and digest checks before any initial asset is published. Callers can explicitly carry provenance and archived state across that seam. Durable persistence remains separate work.

# Visual assets

`@relayer/visual-assets` is the deterministic library/tool seam for logical visual assets. Callers discover registries, root tags, one tag layer, and scoped assets through the `VisualAssetsLibrary` interface. They add only harness-provided file handles and receive logical asset objects; generic content records and digest deduplication remain private to the Module.

Project queries include project-associated assets plus assets associated with authorized project threads. A query narrowed to a project-attached thread includes project assets and that thread's assets. Those threads share the project tag tree; projectless threads own separate tag trees.

Asset bytes are immutable in v1. Organization and scope associations may change, and archival removes user assets from ordinary discovery without removing digest-addressed content. System registries can keep content and default relationships read-only while allowing user-created associations and tag relationships.

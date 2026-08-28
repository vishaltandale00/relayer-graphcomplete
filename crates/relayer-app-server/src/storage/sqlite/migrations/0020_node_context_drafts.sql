CREATE TABLE node_context_drafts (
    id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    target_node_id INTEGER NOT NULL CHECK(target_node_id > 0),
    source_interaction_node_id INTEGER NOT NULL CHECK(source_interaction_node_id > 0),
    source_layer_id INTEGER NOT NULL CHECK(source_layer_id > 0),
    target_node_json TEXT NOT NULL,
    text TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(thread_id, target_node_id)
);

CREATE INDEX node_context_drafts_thread_order
    ON node_context_drafts(thread_id, created_at, id);

CREATE TABLE node_context_draft_resolutions (
    draft_id TEXT NOT NULL PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK(outcome IN ('confirmed','discarded')),
    draft_revision INTEGER NOT NULL CHECK(draft_revision > 0),
    target_node_id INTEGER NOT NULL CHECK(target_node_id > 0),
    source_interaction_node_id INTEGER NOT NULL CHECK(source_interaction_node_id > 0),
    source_layer_id INTEGER NOT NULL CHECK(source_layer_id > 0),
    target_node_json TEXT NOT NULL,
    text TEXT NOT NULL,
    resolved_at TEXT NOT NULL
);

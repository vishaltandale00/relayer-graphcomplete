CREATE TABLE conversation_imports (
    id TEXT PRIMARY KEY NOT NULL,
    source_sha256 TEXT NOT NULL,
    export_version INTEGER NOT NULL,
    producer_json TEXT NOT NULL,
    header_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('staging','published')),
    created_at TEXT NOT NULL,
    published_at TEXT
);

ALTER TABLE threads ADD COLUMN conversation_import_id TEXT REFERENCES conversation_imports(id);

CREATE TABLE imported_turns (
    conversation_import_id TEXT NOT NULL REFERENCES conversation_imports(id) ON DELETE CASCADE,
    source_turn_id TEXT NOT NULL,
    product_interaction_id INTEGER NOT NULL UNIQUE REFERENCES interactions(id) ON DELETE CASCADE,
    source_origin_json TEXT NOT NULL,
    source_completion_json TEXT NOT NULL,
    PRIMARY KEY(conversation_import_id,source_turn_id)
);

CREATE INDEX threads_conversation_import ON threads(conversation_import_id);

CREATE TABLE graph_imports (
    import_id TEXT PRIMARY KEY NOT NULL,
    source_sha256 TEXT NOT NULL,
    project_id INTEGER CHECK(project_id > 0),
    thread_id INTEGER NOT NULL UNIQUE CHECK(thread_id > 0),
    created_at TEXT NOT NULL
);

CREATE TABLE graph_import_turns (
    import_id TEXT NOT NULL REFERENCES graph_imports(import_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    source_turn_id TEXT NOT NULL,
    turn_json TEXT NOT NULL,
    PRIMARY KEY(import_id, position),
    UNIQUE(import_id, source_turn_id)
);

-- Portable evidence is deliberately separate from executable durable_invocations.
ALTER TABLE graph_imports ADD COLUMN inert_invocations_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(inert_invocations_json) AND json_type(inert_invocations_json) = 'array');

-- Imported control relationships are inert history, not native callable bindings.
CREATE TABLE imported_invoke_input_bindings (
    invoke_action_id INTEGER NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
    input_action_id INTEGER NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (invoke_action_id, input_action_id),
    UNIQUE (invoke_action_id, position)
);

CREATE TABLE inert_import_asset_contents (
    import_id TEXT NOT NULL REFERENCES graph_imports(import_id) ON DELETE CASCADE,
    digest_sha256 TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    content BLOB NOT NULL,
    PRIMARY KEY (import_id, digest_sha256)
);
ALTER TABLE graph_imports ADD COLUMN standalone_inputs_json TEXT NOT NULL DEFAULT '[]';

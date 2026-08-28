CREATE TABLE action_input_drafts (
    thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at TEXT NOT NULL
);

CREATE TABLE action_input_attachments (
    thread_id INTEGER NOT NULL REFERENCES action_input_drafts(thread_id) ON DELETE CASCADE,
    presenting_interaction_node_id INTEGER NOT NULL CHECK(presenting_interaction_node_id > 0),
    presenting_layer_id INTEGER NOT NULL CHECK(presenting_layer_id > 0),
    action_id INTEGER NOT NULL CHECK(action_id > 0),
    source_node_id INTEGER NOT NULL CHECK(source_node_id > 0),
    action_json TEXT NOT NULL,
    value_json TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id)
);

CREATE INDEX action_input_attachments_thread
    ON action_input_attachments(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id);

CREATE TABLE action_invocations (
    source_interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    action_id INTEGER NOT NULL,
    result_interaction_id INTEGER NOT NULL UNIQUE REFERENCES interactions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(source_interaction_id, action_id)
);

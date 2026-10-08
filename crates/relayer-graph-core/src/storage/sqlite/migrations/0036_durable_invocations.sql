CREATE TABLE durable_invocations (
    id INTEGER PRIMARY KEY,
    source_completion_id INTEGER NOT NULL REFERENCES nodes(id),
    source_action_id INTEGER NOT NULL REFERENCES actions(id),
    parent_node_id INTEGER NOT NULL REFERENCES nodes(id),
    invocation_key TEXT NOT NULL,
    action_snapshot TEXT NOT NULL,
    child_interaction_node_id INTEGER NOT NULL UNIQUE REFERENCES nodes(id),
    UNIQUE(source_completion_id, invocation_key)
);
CREATE INDEX durable_invocations_action ON durable_invocations(source_action_id, id);
CREATE TRIGGER durable_invocations_immutable BEFORE UPDATE ON durable_invocations
BEGIN SELECT RAISE(ABORT, 'durable invocation identity is immutable'); END;
CREATE TRIGGER durable_invocations_no_delete BEFORE DELETE ON durable_invocations
BEGIN SELECT RAISE(ABORT, 'durable invocation history is immutable'); END;

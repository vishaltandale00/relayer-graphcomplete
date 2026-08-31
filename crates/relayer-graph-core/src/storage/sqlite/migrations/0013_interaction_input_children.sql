CREATE TABLE interaction_input_children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_interaction_node_id INTEGER NOT NULL REFERENCES nodes(id),
    position INTEGER NOT NULL CHECK(position >= 0),
    presenting_interaction_node_id INTEGER NOT NULL REFERENCES nodes(id),
    presenting_layer_id INTEGER NOT NULL REFERENCES layers(id),
    action_id INTEGER NOT NULL REFERENCES actions(id),
    source_node_id INTEGER NOT NULL REFERENCES nodes(id),
    action_snapshot_json TEXT NOT NULL,
    value_snapshot_json TEXT NOT NULL,
    attempt_key TEXT NOT NULL,
    authority_digest TEXT NOT NULL,
    semantic_digest TEXT NOT NULL,
    UNIQUE(parent_interaction_node_id, position),
    UNIQUE(parent_interaction_node_id, presenting_interaction_node_id, presenting_layer_id, action_id)
);

CREATE INDEX interaction_input_children_parent
    ON interaction_input_children(parent_interaction_node_id);
CREATE INDEX interaction_input_children_provenance
    ON interaction_input_children(presenting_interaction_node_id, presenting_layer_id, action_id);

CREATE TRIGGER interaction_input_children_immutable_update
BEFORE UPDATE ON interaction_input_children
BEGIN
    SELECT RAISE(ABORT, 'interaction_input_child_immutable');
END;

CREATE TRIGGER interaction_input_children_immutable_delete
BEFORE DELETE ON interaction_input_children
BEGIN
    SELECT RAISE(ABORT, 'interaction_input_child_immutable');
END;

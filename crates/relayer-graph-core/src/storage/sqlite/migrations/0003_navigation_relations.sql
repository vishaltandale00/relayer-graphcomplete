ALTER TABLE actions
    ADD COLUMN source_layer_id INTEGER REFERENCES layers(id);

ALTER TABLE actions
    ADD COLUMN relation TEXT CHECK(relation IN ('expand', 'reference'));

UPDATE actions
SET relation = 'expand'
WHERE kind = 'navigate';

UPDATE actions
SET source_layer_id = (
    SELECT MIN(layer_actions.layer_id)
    FROM layer_actions
    WHERE layer_actions.action_id = actions.id
)
WHERE source_node_id != owner_interaction_id;

CREATE INDEX actions_source_layer
    ON actions(owner_interaction_id, source_layer_id);

CREATE INDEX actions_target_relation
    ON actions(owner_interaction_id, target_layer_id, relation);

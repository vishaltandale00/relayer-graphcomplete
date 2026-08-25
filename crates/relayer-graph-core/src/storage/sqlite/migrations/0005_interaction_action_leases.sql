ALTER TABLE nodes
    ADD COLUMN leased_action_id INTEGER REFERENCES actions(id);

ALTER TABLE nodes
    ADD COLUMN lease_source_interaction_id INTEGER REFERENCES nodes(id)
    CHECK ((leased_action_id IS NULL) = (lease_source_interaction_id IS NULL));

CREATE UNIQUE INDEX nodes_unique_leased_action
    ON nodes(leased_action_id)
    WHERE leased_action_id IS NOT NULL;

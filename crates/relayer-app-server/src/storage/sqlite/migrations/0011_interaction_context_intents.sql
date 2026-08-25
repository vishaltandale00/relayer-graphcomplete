ALTER TABLE interactions ADD COLUMN input_identity TEXT;
ALTER TABLE interactions ADD COLUMN input_digest TEXT;

CREATE TRIGGER interaction_input_identity_pair_insert
BEFORE INSERT ON interactions
WHEN (NEW.input_identity IS NULL) != (NEW.input_digest IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'interaction_input_identity_pair_required');
END;

CREATE TRIGGER interaction_input_identity_pair_update
BEFORE UPDATE OF input_identity,input_digest ON interactions
WHEN (NEW.input_identity IS NULL) != (NEW.input_digest IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'interaction_input_identity_pair_required');
END;

CREATE UNIQUE INDEX interactions_input_identity
    ON interactions(thread_id, input_identity)
    WHERE input_identity IS NOT NULL;

CREATE TABLE interaction_context_intents (
    interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    target_node_id INTEGER NOT NULL CHECK(target_node_id > 0),
    source_interaction_node_id INTEGER NOT NULL CHECK(source_interaction_node_id > 0),
    source_layer_id INTEGER NOT NULL CHECK(source_layer_id > 0),
    PRIMARY KEY(interaction_id, position),
    UNIQUE(interaction_id, target_node_id)
);

CREATE TABLE interaction_context_annotations (
    interaction_id INTEGER NOT NULL,
    context_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    text TEXT NOT NULL CHECK(length(trim(text)) > 0),
    PRIMARY KEY(interaction_id, context_position, position),
    FOREIGN KEY(interaction_id, context_position)
        REFERENCES interaction_context_intents(interaction_id, position) ON DELETE CASCADE
);

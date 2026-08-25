ALTER TABLE nodes ADD COLUMN input_identity TEXT;
ALTER TABLE nodes ADD COLUMN input_digest TEXT;

CREATE TRIGGER interaction_input_identity_pair_insert
BEFORE INSERT ON nodes
WHEN (NEW.input_identity IS NULL) != (NEW.input_digest IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'interaction_input_identity_pair_required');
END;

CREATE TRIGGER interaction_input_identity_pair_update
BEFORE UPDATE OF input_identity,input_digest ON nodes
WHEN (NEW.input_identity IS NULL) != (NEW.input_digest IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'interaction_input_identity_pair_required');
END;

CREATE UNIQUE INDEX interaction_input_identity
    ON nodes(thread_id, input_identity)
    WHERE input_identity IS NOT NULL;

ALTER TABLE interaction_context_actions ADD COLUMN position INTEGER CHECK(position >= 0);
UPDATE interaction_context_actions
SET position = (
    SELECT COUNT(*) FROM interaction_context_actions prior
    WHERE prior.interaction_node_id=interaction_context_actions.interaction_node_id
      AND prior.action_id < interaction_context_actions.action_id
);

CREATE UNIQUE INDEX interaction_context_position
    ON interaction_context_actions(interaction_node_id, position);

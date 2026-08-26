ALTER TABLE actions
    ADD COLUMN type_id TEXT NOT NULL DEFAULT 'graph.action'
    CHECK(type_id IN ('graph.action', 'interaction.context'));

CREATE TABLE interaction_context_actions (
    action_id INTEGER PRIMARY KEY REFERENCES actions(id) ON DELETE CASCADE,
    interaction_node_id INTEGER NOT NULL REFERENCES nodes(id),
    target_node_id INTEGER NOT NULL REFERENCES nodes(id),
    source_interaction_node_id INTEGER NOT NULL REFERENCES nodes(id),
    source_layer_id INTEGER NOT NULL,
    UNIQUE(action_id, target_node_id),
    FOREIGN KEY(source_layer_id, target_node_id)
        REFERENCES layer_nodes(layer_id, node_id)
);

CREATE UNIQUE INDEX interaction_context_one_target_per_interaction
    ON interaction_context_actions(interaction_node_id, target_node_id);

CREATE TABLE interaction_context_annotations (
    action_id INTEGER NOT NULL REFERENCES interaction_context_actions(action_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    text TEXT NOT NULL CHECK(length(trim(text)) > 0),
    PRIMARY KEY(action_id, position)
);

DROP TRIGGER actions_one_active_root_insert;
DROP TRIGGER actions_one_active_root_update;

CREATE TRIGGER actions_one_active_root_insert
BEFORE INSERT ON actions
WHEN NEW.type_id != 'interaction.context'
  AND NEW.state IN ('draft', 'accepted')
  AND NEW.source_node_id = NEW.owner_interaction_id
  AND NEW.source_layer_id IS NULL
  AND EXISTS (
      SELECT 1 FROM actions existing
      WHERE existing.type_id != 'interaction.context'
        AND existing.owner_interaction_id = NEW.owner_interaction_id
        AND existing.source_node_id = existing.owner_interaction_id
        AND existing.source_layer_id IS NULL
        AND existing.state IN ('draft', 'accepted')
  )
BEGIN
    SELECT RAISE(ABORT, 'root_action_already_exists');
END;

CREATE TRIGGER actions_one_active_root_update
BEFORE UPDATE OF owner_interaction_id, source_node_id, source_layer_id, state, type_id ON actions
WHEN NEW.type_id != 'interaction.context'
  AND NEW.state IN ('draft', 'accepted')
  AND NEW.source_node_id = NEW.owner_interaction_id
  AND NEW.source_layer_id IS NULL
  AND EXISTS (
      SELECT 1 FROM actions existing
      WHERE existing.id <> OLD.id
        AND existing.type_id != 'interaction.context'
        AND existing.owner_interaction_id = NEW.owner_interaction_id
        AND existing.source_node_id = existing.owner_interaction_id
        AND existing.source_layer_id IS NULL
        AND existing.state IN ('draft', 'accepted')
  )
BEGIN
    SELECT RAISE(ABORT, 'root_action_already_exists');
END;

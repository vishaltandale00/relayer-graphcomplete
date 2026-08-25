CREATE TRIGGER actions_one_active_root_insert
BEFORE INSERT ON actions
WHEN NEW.state IN ('draft', 'accepted')
  AND NEW.source_node_id = NEW.owner_interaction_id
  AND NEW.source_layer_id IS NULL
  AND EXISTS (
      SELECT 1
      FROM actions existing
      WHERE existing.owner_interaction_id = NEW.owner_interaction_id
        AND existing.source_node_id = existing.owner_interaction_id
        AND existing.source_layer_id IS NULL
        AND existing.state IN ('draft', 'accepted')
  )
BEGIN
    SELECT RAISE(ABORT, 'root_action_already_exists');
END;

CREATE TRIGGER actions_one_active_root_update
BEFORE UPDATE OF owner_interaction_id, source_node_id, source_layer_id, state ON actions
WHEN NEW.state IN ('draft', 'accepted')
  AND NEW.source_node_id = NEW.owner_interaction_id
  AND NEW.source_layer_id IS NULL
  AND EXISTS (
      SELECT 1
      FROM actions existing
      WHERE existing.id <> OLD.id
        AND existing.owner_interaction_id = NEW.owner_interaction_id
        AND existing.source_node_id = existing.owner_interaction_id
        AND existing.source_layer_id IS NULL
        AND existing.state IN ('draft', 'accepted')
  )
BEGIN
    SELECT RAISE(ABORT, 'root_action_already_exists');
END;

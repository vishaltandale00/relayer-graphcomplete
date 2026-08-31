DROP TRIGGER interaction_input_children_immutable_delete;

CREATE TRIGGER interaction_input_children_immutable_delete
BEFORE DELETE ON interaction_input_children
WHEN NOT EXISTS (
    SELECT 1
    FROM nodes parent
    JOIN graph_imports imported ON imported.thread_id=parent.thread_id
    WHERE parent.id=OLD.parent_interaction_node_id
)
BEGIN
    SELECT RAISE(ABORT, 'interaction_input_child_immutable');
END;

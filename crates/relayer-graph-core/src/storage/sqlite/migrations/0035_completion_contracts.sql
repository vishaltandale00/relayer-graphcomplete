CREATE TABLE completion_contracts (
    interaction_node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
    description TEXT NOT NULL
);
ALTER TABLE completion_states ADD COLUMN completion_contract_digest TEXT;
CREATE TRIGGER completion_contract_update_guard BEFORE UPDATE ON completion_contracts
BEGIN SELECT RAISE(ABORT, 'CompletionContract is immutable'); END;
CREATE TRIGGER completion_contract_delete_guard BEFORE DELETE ON completion_contracts
WHEN NOT EXISTS (SELECT 1 FROM graph_imports i JOIN nodes n ON n.thread_id=i.thread_id WHERE n.id=OLD.interaction_node_id)
BEGIN SELECT RAISE(ABORT, 'CompletionContract is immutable'); END;
CREATE TRIGGER completion_contract_marker_guard BEFORE UPDATE OF completion_contract_digest ON completion_states
WHEN OLD.completion_contract_digest IS NOT NULL AND NEW.completion_contract_digest IS NOT OLD.completion_contract_digest
BEGIN SELECT RAISE(ABORT, 'CompletionContract identity is immutable'); END;

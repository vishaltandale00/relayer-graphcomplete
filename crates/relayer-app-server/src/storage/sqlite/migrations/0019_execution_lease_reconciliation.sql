ALTER TABLE interaction_attempts ADD COLUMN execution_lease_id TEXT;
ALTER TABLE interaction_attempts ADD COLUMN execution_lease_reconciled_at TEXT;

CREATE TRIGGER interaction_attempt_execution_lease_pair_insert
BEFORE INSERT ON interaction_attempts
WHEN NEW.execution_lease_reconciled_at IS NOT NULL AND NEW.execution_lease_id IS NULL
BEGIN
    SELECT RAISE(ABORT, 'a reconciled execution lease requires an execution lease id');
END;

CREATE TRIGGER interaction_attempt_execution_lease_pair_update
BEFORE UPDATE OF execution_lease_id,execution_lease_reconciled_at ON interaction_attempts
WHEN NEW.execution_lease_reconciled_at IS NOT NULL AND NEW.execution_lease_id IS NULL
BEGIN
    SELECT RAISE(ABORT, 'a reconciled execution lease requires an execution lease id');
END;

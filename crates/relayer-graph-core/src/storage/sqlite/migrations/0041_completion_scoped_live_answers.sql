-- Preserve historical receipt identities and JSON bytes. Only future allocation
-- is completion-local; accepted historical gaps cannot be renumbered.
CREATE TABLE live_answers_scoped (
    sequence INTEGER NOT NULL,
    completion_id INTEGER NOT NULL REFERENCES nodes(id),
    attempt_id INTEGER NOT NULL CHECK(attempt_id > 0),
    authority_epoch INTEGER NOT NULL,
    current_revision INTEGER NOT NULL,
    presenting_layer_id INTEGER NOT NULL REFERENCES layers(id),
    action_id INTEGER NOT NULL REFERENCES actions(id),
    operation_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    PRIMARY KEY(completion_id, sequence),
    UNIQUE(completion_id, operation_key),
    UNIQUE(completion_id, presenting_layer_id, action_id)
);
INSERT INTO live_answers_scoped
    SELECT sequence, completion_id, attempt_id, authority_epoch, current_revision,
        presenting_layer_id, action_id, operation_key, request_json, receipt_json
    FROM live_answers;
DROP TRIGGER live_answers_immutable;
DROP TRIGGER live_answers_no_delete;
DROP TABLE live_answers;
ALTER TABLE live_answers_scoped RENAME TO live_answers;
CREATE TRIGGER live_answers_immutable BEFORE UPDATE ON live_answers
BEGIN SELECT RAISE(ABORT, 'accepted live answers are immutable'); END;
CREATE TRIGGER live_answers_no_delete BEFORE DELETE ON live_answers
BEGIN SELECT RAISE(ABORT, 'accepted live answer history is immutable'); END;

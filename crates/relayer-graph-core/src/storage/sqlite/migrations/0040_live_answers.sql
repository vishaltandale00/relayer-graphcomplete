CREATE TABLE live_answers (
    sequence INTEGER PRIMARY KEY,
    completion_id INTEGER NOT NULL REFERENCES nodes(id),
    attempt_id INTEGER NOT NULL CHECK(attempt_id > 0),
    authority_epoch INTEGER NOT NULL,
    current_revision INTEGER NOT NULL,
    presenting_layer_id INTEGER NOT NULL REFERENCES layers(id),
    action_id INTEGER NOT NULL REFERENCES actions(id),
    operation_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    UNIQUE(completion_id, operation_key),
    UNIQUE(completion_id, presenting_layer_id, action_id)
);
CREATE TRIGGER live_answers_immutable BEFORE UPDATE ON live_answers
BEGIN SELECT RAISE(ABORT, 'accepted live answers are immutable'); END;
CREATE TRIGGER live_answers_no_delete BEFORE DELETE ON live_answers
BEGIN SELECT RAISE(ABORT, 'accepted live answer history is immutable'); END;

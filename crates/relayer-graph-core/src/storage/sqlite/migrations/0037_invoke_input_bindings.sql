CREATE TABLE invoke_input_bindings (
    invoke_action_id INTEGER NOT NULL REFERENCES actions(id),
    input_action_id INTEGER NOT NULL REFERENCES actions(id),
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(invoke_action_id, input_action_id),
    UNIQUE(invoke_action_id, position)
);
CREATE TRIGGER invoke_input_bindings_accepted_insert BEFORE INSERT ON invoke_input_bindings
WHEN (SELECT state FROM actions WHERE id=NEW.invoke_action_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'accepted invoke input bindings are immutable'); END;
CREATE TRIGGER invoke_input_bindings_accepted_delete BEFORE DELETE ON invoke_input_bindings
WHEN (SELECT state FROM actions WHERE id=OLD.invoke_action_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'accepted invoke input bindings are immutable'); END;
CREATE TRIGGER invoke_input_bindings_no_update BEFORE UPDATE ON invoke_input_bindings
BEGIN SELECT RAISE(ABORT, 'replace draft invoke input bindings explicitly'); END;

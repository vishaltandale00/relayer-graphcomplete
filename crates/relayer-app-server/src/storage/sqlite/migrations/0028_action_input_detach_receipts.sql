CREATE TABLE action_input_detach_receipts (
    thread_id INTEGER NOT NULL REFERENCES action_input_drafts(thread_id) ON DELETE CASCADE,
    presenting_interaction_node_id INTEGER NOT NULL CHECK(presenting_interaction_node_id > 0),
    presenting_layer_id INTEGER NOT NULL CHECK(presenting_layer_id > 0),
    action_id INTEGER NOT NULL CHECK(action_id > 0),
    expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
    result_revision INTEGER NOT NULL CHECK(result_revision = expected_revision + 1),
    PRIMARY KEY(
        thread_id,presenting_interaction_node_id,presenting_layer_id,action_id,expected_revision
    )
);

DROP TRIGGER submitted_input_attempt_restore;

CREATE TRIGGER submitted_input_attempt_restore
AFTER UPDATE OF completion_status ON interactions
WHEN OLD.completion_status != NEW.completion_status
  AND NEW.completion_status IN ('failed','stopped','not_started')
  AND COALESCE(NEW.completion_error,'') NOT LIKE 'Canonical reconciliation pending:%'
  AND EXISTS(
      SELECT 1 FROM interaction_submitted_input_attempts attempt
      WHERE attempt.interaction_id=NEW.id
        AND attempt.state NOT IN ('accepted','failed','stopped')
  )
BEGIN
    INSERT INTO action_input_attachments(
        thread_id,presenting_interaction_node_id,presenting_layer_id,action_id,
        source_node_id,action_json,value_json,committed_at
    )
    SELECT attempt.thread_id,snapshot.presenting_interaction_node_id,
           snapshot.presenting_layer_id,snapshot.action_id,snapshot.source_node_id,
           snapshot.action_json,snapshot.value_json,snapshot.committed_at
    FROM interaction_submitted_input_attempts attempt
    JOIN interaction_submitted_input_attachments snapshot
      ON snapshot.interaction_id=attempt.interaction_id
    WHERE attempt.interaction_id=NEW.id
    ON CONFLICT(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id)
    DO NOTHING;

    UPDATE interactions
    SET completion_error=COALESCE(completion_error,'Submitted input was restored after the attempt ended before graph acceptance.')
        || ' A newer committed value was preserved instead of restoring this attempt''s earlier value.'
    WHERE id=NEW.id AND EXISTS(
        SELECT 1
        FROM interaction_submitted_input_attempts attempt
        JOIN interaction_submitted_input_attachments snapshot
          ON snapshot.interaction_id=attempt.interaction_id
        JOIN action_input_attachments current
          ON current.thread_id=attempt.thread_id
         AND current.presenting_interaction_node_id=snapshot.presenting_interaction_node_id
         AND current.presenting_layer_id=snapshot.presenting_layer_id
         AND current.action_id=snapshot.action_id
        WHERE attempt.interaction_id=NEW.id
          AND (current.source_node_id!=snapshot.source_node_id
               OR current.action_json!=snapshot.action_json
               OR current.value_json!=snapshot.value_json)
    );

    UPDATE action_input_drafts
    SET revision=revision+1
    WHERE thread_id=(
        SELECT thread_id FROM interaction_submitted_input_attempts WHERE interaction_id=NEW.id
    );

    UPDATE interaction_submitted_input_attempts
    SET state=CASE WHEN NEW.completion_status='stopped' THEN 'stopped' ELSE 'failed' END,
        finished_at=COALESCE(finished_at,strftime('%s','now') || '000')
    WHERE interaction_id=NEW.id;

    UPDATE interactions
    SET completion_status='failed',
        completion_error=COALESCE(completion_error,'Submitted input was restored after the attempt ended before graph acceptance.')
    WHERE id=NEW.id AND NEW.completion_status='not_started';
END;

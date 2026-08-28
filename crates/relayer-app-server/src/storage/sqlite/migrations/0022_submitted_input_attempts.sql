CREATE TABLE interaction_submitted_input_attempts (
    interaction_id INTEGER PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    draft_revision INTEGER NOT NULL CHECK(draft_revision > 0),
    authority_digest TEXT NOT NULL,
    semantic_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','preparing','bound','running','accepted','failed','stopped')),
    graph_root_node_id INTEGER,
    child_receipt_json TEXT,
    created_at TEXT NOT NULL,
    bound_at TEXT,
    finished_at TEXT
);

CREATE UNIQUE INDEX interaction_submitted_input_attempt_thread_identity
    ON interaction_submitted_input_attempts(thread_id, interaction_id);

CREATE TABLE interaction_submitted_input_attachments (
    interaction_id INTEGER NOT NULL REFERENCES interaction_submitted_input_attempts(interaction_id) ON DELETE CASCADE,
    presenting_interaction_node_id INTEGER NOT NULL CHECK(presenting_interaction_node_id > 0),
    presenting_layer_id INTEGER NOT NULL CHECK(presenting_layer_id > 0),
    action_id INTEGER NOT NULL CHECK(action_id > 0),
    source_node_id INTEGER NOT NULL CHECK(source_node_id > 0),
    action_json TEXT NOT NULL,
    value_json TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY(interaction_id,presenting_interaction_node_id,presenting_layer_id,action_id)
);

CREATE INDEX interaction_submitted_input_attachment_occurrence
    ON interaction_submitted_input_attachments(
        presenting_interaction_node_id,presenting_layer_id,action_id
    );

CREATE TRIGGER submitted_input_attempt_preparing
AFTER UPDATE OF completion_status ON interactions
WHEN OLD.completion_status != NEW.completion_status
  AND NEW.completion_status='submitted'
BEGIN
    UPDATE interaction_submitted_input_attempts
    SET state='preparing'
    WHERE interaction_id=NEW.id AND state='reserved';
END;

CREATE TRIGGER submitted_input_attempt_running
AFTER UPDATE OF completion_status ON interactions
WHEN OLD.completion_status != NEW.completion_status
  AND NEW.completion_status='running'
BEGIN
    UPDATE interaction_submitted_input_attempts
    SET state='running'
    WHERE interaction_id=NEW.id AND state IN ('preparing','bound');
END;

CREATE TRIGGER submitted_input_attempt_accepted
AFTER UPDATE OF completion_status ON interactions
WHEN OLD.completion_status != NEW.completion_status
  AND NEW.completion_status='accepted'
BEGIN
    UPDATE interaction_submitted_input_attempts
    SET state='accepted',finished_at=COALESCE(finished_at,strftime('%s','now') || '000')
    WHERE interaction_id=NEW.id AND state NOT IN ('accepted','failed','stopped');
END;

CREATE TRIGGER submitted_input_attempt_restore
AFTER UPDATE OF completion_status ON interactions
WHEN OLD.completion_status != NEW.completion_status
  AND NEW.completion_status IN ('failed','stopped','not_started')
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
               OR current.value_json!=snapshot.value_json
               OR current.committed_at!=snapshot.committed_at)
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

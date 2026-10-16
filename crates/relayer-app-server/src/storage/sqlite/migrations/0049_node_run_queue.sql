-- A run a user starts on a node records that node (#718). Runs on one node start in order:
-- while another run on the node is active, a new one waits as `queued`. The node is the
-- action's source node, the node the user interacted with.
CREATE TABLE node_runs (
    result_interaction_id INTEGER PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL CHECK(node_id > 0)
);
CREATE INDEX node_runs_by_node ON node_runs(thread_id, node_id);

-- A queued run is active work: it keeps its thread out of the archive, and it cannot be
-- queued or started on an archived thread.
DROP VIEW thread_archive_activity;
CREATE VIEW thread_archive_activity AS
SELECT t.id, (
    EXISTS(SELECT 1 FROM interactions i WHERE i.thread_id=t.id AND i.completion_status IN ('not_started','preparing','queued','running','submitted','waiting_for_approval'))
    OR EXISTS(SELECT 1 FROM interaction_attempts a JOIN interactions i ON i.id=a.interaction_id WHERE i.thread_id=t.id AND a.outcome='running' AND a.native_wait_ended_at IS NULL)
    OR EXISTS(SELECT 1 FROM interaction_submitted_input_attempts a JOIN interactions i ON i.id=a.interaction_id WHERE i.thread_id=t.id AND a.state NOT IN ('accepted','failed','stopped'))
    OR EXISTS(SELECT 1 FROM completion_executions e JOIN interactions i ON i.id=e.interaction_id WHERE i.thread_id=t.id AND e.phase!='settled')
) AS busy FROM threads t;

DROP TRIGGER archived_thread_interaction_start;
CREATE TRIGGER archived_thread_interaction_start BEFORE UPDATE OF completion_status ON interactions
WHEN NEW.completion_status IN ('not_started','preparing','queued','running','submitted','waiting_for_approval')
AND EXISTS(SELECT 1 FROM threads WHERE id=NEW.thread_id AND archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'thread_archived'); END;

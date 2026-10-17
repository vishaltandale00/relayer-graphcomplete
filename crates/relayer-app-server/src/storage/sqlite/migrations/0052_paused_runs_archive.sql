-- A run a restart paused or interrupted (#722) is not active work, so it never keeps its
-- thread out of the archive, even when its send reserved answered inputs before it paused.
-- Resuming it on an archived thread is still refused by archived_thread_interaction_start.
DROP VIEW thread_archive_activity;
CREATE VIEW thread_archive_activity AS
SELECT t.id, (
    EXISTS(SELECT 1 FROM interactions i WHERE i.thread_id=t.id AND i.completion_status IN ('not_started','preparing','queued','running','submitted','waiting_for_approval'))
    OR EXISTS(SELECT 1 FROM interaction_attempts a JOIN interactions i ON i.id=a.interaction_id WHERE i.thread_id=t.id AND a.outcome='running' AND a.native_wait_ended_at IS NULL)
    OR EXISTS(SELECT 1 FROM interaction_submitted_input_attempts a JOIN interactions i ON i.id=a.interaction_id WHERE i.thread_id=t.id AND a.state NOT IN ('accepted','failed','stopped') AND i.completion_status NOT IN ('paused','interrupted'))
    OR EXISTS(SELECT 1 FROM completion_executions e JOIN interactions i ON i.id=e.interaction_id WHERE i.thread_id=t.id AND e.phase!='settled')
) AS busy FROM threads t;

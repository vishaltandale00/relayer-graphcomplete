-- Migration 0003 allowed the same node-owned action to be invoked from more than one
-- accepted rendering of that node inside a project. The lease contract makes the action
-- project-scoped, so retain the invocation that the current lookup order would have returned
-- and preserve every other result interaction as ordinary history.
WITH ranked_invocations AS (
    SELECT
        ai.result_interaction_id,
        ROW_NUMBER() OVER (
            PARTITION BY
                CASE
                    WHEN thread.project_id IS NOT NULL THEN 'project:' || thread.project_id
                    ELSE 'thread:' || thread.id
                END,
                ai.action_id
            ORDER BY ai.created_at, ai.source_interaction_id, ai.result_interaction_id
        ) AS invocation_rank
    FROM action_invocations ai
    JOIN interactions source ON source.id = ai.source_interaction_id
    JOIN threads thread ON thread.id = source.thread_id
)
UPDATE interactions
SET completion_status = 'failed',
    completion_error = 'Legacy duplicate action invocation was superseded during graph lease migration. Its interaction history was retained.'
WHERE id IN (
    SELECT result_interaction_id
    FROM ranked_invocations
    WHERE invocation_rank > 1
)
AND completion_status IN ('not_started', 'running', 'submitted', 'waiting_for_approval');

WITH ranked_invocations AS (
    SELECT
        ai.result_interaction_id,
        ROW_NUMBER() OVER (
            PARTITION BY
                CASE
                    WHEN thread.project_id IS NOT NULL THEN 'project:' || thread.project_id
                    ELSE 'thread:' || thread.id
                END,
                ai.action_id
            ORDER BY ai.created_at, ai.source_interaction_id, ai.result_interaction_id
        ) AS invocation_rank
    FROM action_invocations ai
    JOIN interactions source ON source.id = ai.source_interaction_id
    JOIN threads thread ON thread.id = source.thread_id
)
DELETE FROM action_invocations
WHERE result_interaction_id IN (
    SELECT result_interaction_id
    FROM ranked_invocations
    WHERE invocation_rank > 1
);

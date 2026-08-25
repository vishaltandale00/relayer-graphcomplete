-- Keep every legacy source/action/result mapping for faithful history and export, while choosing
-- exactly one mapping in each action scope as the authority used for execution and lease recovery.
ALTER TABLE action_invocations
ADD COLUMN authoritative INTEGER NOT NULL DEFAULT 1
CHECK (authoritative IN (0, 1));

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
            ORDER BY
                CASE WHEN result.completion_status = 'accepted' THEN 0 ELSE 1 END,
                ai.created_at,
                ai.source_interaction_id,
                ai.result_interaction_id
        ) AS invocation_rank
    FROM action_invocations ai
    JOIN interactions source ON source.id = ai.source_interaction_id
    JOIN interactions result ON result.id = ai.result_interaction_id
    JOIN threads thread ON thread.id = source.thread_id
)
UPDATE action_invocations
SET authoritative = CASE
    WHEN result_interaction_id IN (
        SELECT result_interaction_id FROM ranked_invocations WHERE invocation_rank = 1
    ) THEN 1
    ELSE 0
END;

UPDATE interactions
SET completion_status = 'failed',
    completion_error = 'Legacy duplicate action invocation was superseded during graph lease migration. Its action origin was retained as history.'
WHERE id IN (
    SELECT result_interaction_id FROM action_invocations WHERE authoritative = 0
)
AND completion_status IN ('not_started', 'running', 'submitted', 'waiting_for_approval');

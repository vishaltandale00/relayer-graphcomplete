ALTER TABLE threads ADD COLUMN permission_profile_id TEXT NOT NULL DEFAULT 'auto';

UPDATE threads
SET permission_profile_id = 'full'
WHERE harness_configuration_name IN ('prime-agent-basic', 'prime-agent-deep');

ALTER TABLE interactions ADD COLUMN permission_profile_id TEXT NOT NULL DEFAULT 'auto';

UPDATE interactions
SET permission_profile_id = 'full'
WHERE thread_id IN (
    SELECT id FROM threads WHERE permission_profile_id = 'full'
);

ALTER TABLE interactions ADD COLUMN effective_execution_digest TEXT;
ALTER TABLE interactions ADD COLUMN effective_permission_receipt_json TEXT;

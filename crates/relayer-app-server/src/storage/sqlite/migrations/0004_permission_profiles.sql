ALTER TABLE threads ADD COLUMN permission_profile_id TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE interactions ADD COLUMN permission_profile_id TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE interactions ADD COLUMN effective_execution_digest TEXT;
ALTER TABLE interactions ADD COLUMN effective_permission_receipt_json TEXT;

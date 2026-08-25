ALTER TABLE model_providers ADD COLUMN adapter_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE model_providers ADD COLUMN access_contract TEXT NOT NULL DEFAULT 'secret@1';
ALTER TABLE model_providers ADD COLUMN endpoint TEXT;
ALTER TABLE model_providers ADD COLUMN credential_reference TEXT;
ALTER TABLE model_providers ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'removal_pending', 'tombstoned'));
ALTER TABLE model_providers ADD COLUMN removed_at TEXT;

-- Existing provider ids represented both a concrete connection and its adapter.
-- Preserve the concrete id while making the adapter/access dimensions explicit.
UPDATE model_providers SET adapter_id=id;
UPDATE model_providers
SET adapter_id='codex-subscription',access_contract='managed-runtime@1'
WHERE id='codex';

CREATE UNIQUE INDEX model_providers_active_label_nocase
ON model_providers(label COLLATE NOCASE)
WHERE lifecycle_state IN ('active','removal_pending');

CREATE UNIQUE INDEX model_providers_credential_reference
ON model_providers(credential_reference)
WHERE credential_reference IS NOT NULL;

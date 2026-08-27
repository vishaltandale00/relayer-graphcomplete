ALTER TABLE node_context_draft_resolutions ADD COLUMN composer_text TEXT;
ALTER TABLE node_context_draft_resolutions ADD COLUMN composer_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE node_context_draft_resolutions ADD COLUMN dismissed_at TEXT;
ALTER TABLE node_context_draft_resolutions ADD COLUMN consumed_interaction_id INTEGER REFERENCES interactions(id) ON DELETE SET NULL;

-- Schema 20 confirmations were terminal history, not recoverable composer state. Preserve that
-- behavior on upgrade instead of surfacing every historical confirmation as newly pending.
UPDATE node_context_draft_resolutions
SET composer_text = text,
    dismissed_at = resolved_at
WHERE outcome = 'confirmed';

CREATE INDEX node_context_draft_resolutions_pending_composer
    ON node_context_draft_resolutions(thread_id, resolved_at, draft_id)
    WHERE outcome = 'confirmed' AND dismissed_at IS NULL AND consumed_interaction_id IS NULL;

-- Development builds of the provider platform may already have applied migration 0013 with a
-- strictly-positive adapter version. Rebuild the unreleased attempt table so pre-admission
-- failures can durably use version 0 without requiring users to reset their local database.
ALTER TABLE interaction_attempts RENAME TO interaction_attempts_before_pre_execution_receipts;

CREATE TABLE interaction_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    family_id INTEGER NOT NULL,
    family_revision INTEGER NOT NULL CHECK (family_revision > 0),
    harness_configuration_name TEXT NOT NULL,
    harness_configuration_revision INTEGER NOT NULL CHECK (harness_configuration_revision > 0),
    harness_configuration_digest TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    adapter_implementation_version INTEGER NOT NULL CHECK (adapter_implementation_version >= 0),
    model_id TEXT NOT NULL,
    access_contract TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('running','accepted','model_failed','execution_failed','cancelled')),
    failure_category TEXT,
    effect_boundary TEXT NOT NULL DEFAULT 'unknown'
        CHECK (effect_boundary IN ('none','partial_output','graph_write','tool_effect','unknown')),
    UNIQUE (interaction_id,attempt_number),
    CHECK ((outcome='running') = (finished_at IS NULL)),
    CHECK (failure_category IS NULL OR outcome NOT IN ('running','accepted'))
);

INSERT INTO interaction_attempts(
    id,interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,
    harness_configuration_name,harness_configuration_revision,harness_configuration_digest,
    provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,
    failure_category,effect_boundary
)
SELECT
    id,interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,
    harness_configuration_name,harness_configuration_revision,harness_configuration_digest,
    provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,
    failure_category,effect_boundary
FROM interaction_attempts_before_pre_execution_receipts;

DROP TABLE interaction_attempts_before_pre_execution_receipts;

CREATE INDEX interaction_attempts_interaction
ON interaction_attempts(interaction_id,attempt_number);

ALTER TABLE product_harnesses ADD COLUMN configuration_revision INTEGER NOT NULL DEFAULT 1
    CHECK (configuration_revision > 0);
ALTER TABLE product_harnesses ADD COLUMN configuration_digest TEXT NOT NULL DEFAULT 'sha256:legacy';
ALTER TABLE product_harnesses ADD COLUMN model_rules_present INTEGER NOT NULL DEFAULT 0
    CHECK (model_rules_present IN (0,1));
ALTER TABLE product_harnesses ADD COLUMN execution_access_contracts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE product_harnesses ADD COLUMN family_policy_id TEXT;
ALTER TABLE product_harnesses ADD COLUMN family_policy_version INTEGER
    CHECK (family_policy_version IS NULL OR family_policy_version > 0);

CREATE TABLE harness_model_rules (
    harness_configuration_name TEXT NOT NULL
        REFERENCES product_harnesses(configuration_name) ON DELETE CASCADE,
    effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
    position INTEGER NOT NULL CHECK (position >= 0),
    adapter_id TEXT NOT NULL,
    match_kind TEXT NOT NULL CHECK (match_kind IN ('exact','regex')),
    model_pattern TEXT NOT NULL,
    PRIMARY KEY (harness_configuration_name,effect,position)
);

ALTER TABLE model_families ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision > 0);
ALTER TABLE model_families ADD COLUMN managed_provider_id TEXT
    REFERENCES model_providers(id) ON DELETE RESTRICT;
ALTER TABLE model_families ADD COLUMN policy_id TEXT;
ALTER TABLE model_families ADD COLUMN policy_version INTEGER
    CHECK (policy_version IS NULL OR policy_version > 0);
ALTER TABLE model_families ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active','tombstoned'));
ALTER TABLE model_families ADD COLUMN removed_at TEXT;

CREATE UNIQUE INDEX model_families_managed_policy
ON model_families(managed_provider_id,policy_id,policy_version);

ALTER TABLE product_model_preferences ADD COLUMN default_family_id INTEGER
    REFERENCES model_families(id) ON DELETE RESTRICT;

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
    adapter_implementation_version INTEGER NOT NULL CHECK (adapter_implementation_version > 0),
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

CREATE INDEX interaction_attempts_interaction
ON interaction_attempts(interaction_id,attempt_number);

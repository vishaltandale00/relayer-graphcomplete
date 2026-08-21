CREATE TABLE model_providers (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    connected INTEGER NOT NULL CHECK (connected IN (0, 1)),
    unavailable_reason_code TEXT,
    unavailable_reason_message TEXT,
    refreshed_at TEXT NOT NULL,
    CHECK ((unavailable_reason_code IS NULL) = (unavailable_reason_message IS NULL))
);

CREATE TABLE provider_models (
    provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    label TEXT NOT NULL,
    provider_order INTEGER NOT NULL CHECK (provider_order >= 0),
    visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    unavailable_reason_code TEXT,
    unavailable_reason_message TEXT,
    provider_default INTEGER NOT NULL CHECK (provider_default IN (0, 1)),
    replacement_model_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (provider_id, model_id),
    CHECK ((unavailable_reason_code IS NULL) = (unavailable_reason_message IS NULL))
);

CREATE TABLE product_harnesses (
    configuration_name TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    product_visible INTEGER NOT NULL CHECK (product_visible IN (0, 1)),
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    unavailable_reason_code TEXT,
    unavailable_reason_message TEXT,
    CHECK ((unavailable_reason_code IS NULL) = (unavailable_reason_message IS NULL))
);

CREATE TABLE harness_provider_compatibility (
    harness_configuration_name TEXT NOT NULL REFERENCES product_harnesses(configuration_name) ON DELETE CASCADE,
    provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
    all_models INTEGER NOT NULL CHECK (all_models IN (0, 1)),
    preferred_model_id TEXT,
    PRIMARY KEY (harness_configuration_name, provider_id)
);

CREATE TABLE harness_model_compatibility (
    harness_configuration_name TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    PRIMARY KEY (harness_configuration_name, provider_id, model_id),
    FOREIGN KEY (harness_configuration_name, provider_id)
        REFERENCES harness_provider_compatibility(harness_configuration_name, provider_id)
        ON DELETE CASCADE
);

CREATE TABLE model_families (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('system', 'custom')),
    system_key TEXT UNIQUE,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
    CHECK ((kind = 'system') = (system_key IS NOT NULL))
);

CREATE UNIQUE INDEX model_families_name_nocase ON model_families(name COLLATE NOCASE);

CREATE TABLE model_family_members (
    family_id INTEGER NOT NULL REFERENCES model_families(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0 AND position < 5),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    PRIMARY KEY (family_id, position),
    UNIQUE (family_id, provider_id, model_id),
    FOREIGN KEY (provider_id, model_id) REFERENCES provider_models(provider_id, model_id) ON DELETE RESTRICT
);

CREATE TABLE product_model_preferences (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    default_harness_configuration_name TEXT NOT NULL REFERENCES product_harnesses(configuration_name) ON DELETE RESTRICT,
    default_provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT,
    defaults_modified INTEGER NOT NULL CHECK (defaults_modified IN (0, 1))
);

INSERT INTO model_providers(
    id,label,connected,unavailable_reason_code,unavailable_reason_message,refreshed_at
) VALUES (
    'codex','Codex',0,'provider_disconnected','Codex is not connected.','0'
);

INSERT INTO product_harnesses(
    configuration_name,label,product_visible,available,unavailable_reason_code,unavailable_reason_message
) VALUES (
    'codex-basic','Codex Basic',1,0,'harness_unavailable','The harness runtime is unavailable.'
);

INSERT OR IGNORE INTO product_harnesses(
    configuration_name,label,product_visible,available,unavailable_reason_code,unavailable_reason_message
)
SELECT DISTINCT harness_configuration_name,harness_configuration_name,1,0,
       'harness_unavailable','The harness runtime is unavailable.'
FROM threads;

INSERT INTO harness_provider_compatibility(harness_configuration_name,provider_id,all_models)
SELECT configuration_name,'codex',1 FROM product_harnesses;

INSERT INTO product_model_preferences(
    singleton,default_harness_configuration_name,default_provider_id,defaults_modified
) VALUES (
    1,
    COALESCE((SELECT harness_configuration_name FROM threads ORDER BY id LIMIT 1),'codex-basic'),
    'codex',
    0
);

ALTER TABLE interactions ADD COLUMN model_provider_id TEXT;
ALTER TABLE interactions ADD COLUMN provider_model_id TEXT;
ALTER TABLE interactions ADD COLUMN model_family_id INTEGER;

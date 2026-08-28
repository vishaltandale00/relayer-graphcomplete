CREATE TABLE completion_executions (
    interaction_id INTEGER NOT NULL PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
    graph_completion_id INTEGER NOT NULL UNIQUE CHECK(graph_completion_id > 0),
    harness_configuration_name TEXT NOT NULL CHECK(length(harness_configuration_name) > 0),
    harness_configuration_digest TEXT NOT NULL CHECK(length(harness_configuration_digest) > 0),
    model_execution_digest TEXT NOT NULL CHECK(length(model_execution_digest) > 0),
    permission_origin_digest TEXT NOT NULL CHECK(length(permission_origin_digest) > 0),
    phase TEXT NOT NULL CHECK(phase IN ('reserved','launching','attached','settled')),
    attachment_json TEXT,
    settlement_json TEXT,
    safe_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(phase != 'attached' OR attachment_json IS NOT NULL),
    CHECK(phase = 'settled' OR (settlement_json IS NULL AND safe_reason IS NULL)),
    CHECK(phase != 'settled' OR settlement_json IS NOT NULL OR safe_reason IS NOT NULL)
);

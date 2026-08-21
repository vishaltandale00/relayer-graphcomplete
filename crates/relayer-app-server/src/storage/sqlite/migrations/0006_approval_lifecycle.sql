CREATE TABLE approval_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    complete_call_id TEXT NOT NULL,
    harness_session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    action_json TEXT NOT NULL,
    scope_keys_json TEXT NOT NULL,
    scope_description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT
);

CREATE INDEX approval_requests_interaction_created
    ON approval_requests(interaction_id, created_at);

CREATE TABLE approval_resolutions (
    request_id TEXT PRIMARY KEY NOT NULL REFERENCES approval_requests(request_id) ON DELETE CASCADE,
    outcome TEXT NOT NULL,
    actor TEXT NOT NULL,
    decision TEXT,
    rationale TEXT,
    source_request_id TEXT,
    resolved_at TEXT NOT NULL
);

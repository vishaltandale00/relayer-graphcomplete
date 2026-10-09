CREATE TABLE action_invocations_reusable (
    source_interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    action_id INTEGER NOT NULL,
    result_interaction_id INTEGER NOT NULL UNIQUE REFERENCES interactions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    graph_lease_required INTEGER NOT NULL DEFAULT 0 CHECK(graph_lease_required IN (0,1)),
    authoritative INTEGER NOT NULL DEFAULT 1 CHECK(authoritative IN (0,1)),
    agent_invoked INTEGER NOT NULL DEFAULT 0 CHECK(agent_invoked IN (0,1)),
    graph_failure_pending INTEGER NOT NULL DEFAULT 0 CHECK(graph_failure_pending IN (0,1)),
    invocation_key TEXT NOT NULL DEFAULT 'legacy',
    prepared_graph_node_id INTEGER UNIQUE,
    PRIMARY KEY(source_interaction_id, action_id, invocation_key)
);
INSERT INTO action_invocations_reusable(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative,agent_invoked,graph_failure_pending)
SELECT source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative,agent_invoked,graph_failure_pending FROM action_invocations;
DROP TABLE action_invocations;
ALTER TABLE action_invocations_reusable RENAME TO action_invocations;

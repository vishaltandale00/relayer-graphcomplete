-- Preparation freezes opt-in only for new identities; existing contracts are untouched.
CREATE TABLE interaction_plan_policy (
    interaction_node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    final_plan_node_id INTEGER REFERENCES nodes(id)
);
CREATE TABLE interaction_plans (
    node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
    interaction_node_id INTEGER NOT NULL REFERENCES interaction_plan_policy(interaction_node_id),
    revision INTEGER NOT NULL CHECK(revision>0),
    client_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    read_plan_node_ids TEXT NOT NULL,
    UNIQUE(interaction_node_id, revision),
    UNIQUE(interaction_node_id, client_key)
);
CREATE TABLE interaction_plan_reads (
    interaction_node_id INTEGER NOT NULL REFERENCES nodes(id),
    plan_node_id INTEGER NOT NULL REFERENCES interaction_plans(node_id),
    PRIMARY KEY(interaction_node_id,plan_node_id)
);

CREATE TRIGGER internal_plan_layer_nodes_insert BEFORE INSERT ON layer_nodes
WHEN EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.node_id)
BEGIN SELECT RAISE(ABORT,'Internal plan records cannot enter response topology or input'); END;

CREATE TRIGGER internal_plan_layer_nodes_update BEFORE UPDATE ON layer_nodes
WHEN EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.node_id)
BEGIN SELECT RAISE(ABORT,'Internal plan records cannot enter response topology or input'); END;

CREATE TRIGGER internal_plan_edges_insert BEFORE INSERT ON edges
WHEN EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.left_id) OR EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.right_id)
BEGIN SELECT RAISE(ABORT,'Internal plan records cannot enter response topology or input'); END;

CREATE TRIGGER internal_plan_edges_update BEFORE UPDATE ON edges
WHEN EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.left_id) OR EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.right_id)
BEGIN SELECT RAISE(ABORT,'Internal plan records cannot enter response topology or input'); END;

CREATE TRIGGER internal_plan_actions_insert BEFORE INSERT ON actions
WHEN EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.source_node_id)
BEGIN SELECT RAISE(ABORT,'Internal plan records cannot enter response topology or input'); END;

CREATE TRIGGER internal_plan_actions_update BEFORE UPDATE ON actions
WHEN EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.source_node_id)
BEGIN SELECT RAISE(ABORT,'Internal plan records cannot enter response topology or input'); END;

CREATE TRIGGER internal_plan_interaction_context_actions_insert BEFORE INSERT ON interaction_context_actions
WHEN EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.target_node_id)
BEGIN SELECT RAISE(ABORT,'Internal plan records cannot enter response topology or input'); END;

CREATE TRIGGER internal_plan_interaction_context_actions_update BEFORE UPDATE ON interaction_context_actions
WHEN EXISTS(SELECT 1 FROM interaction_plans WHERE node_id=NEW.target_node_id)
BEGIN SELECT RAISE(ABORT,'Internal plan records cannot enter response topology or input'); END;

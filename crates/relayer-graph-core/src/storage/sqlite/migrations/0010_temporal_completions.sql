ALTER TABLE nodes ADD COLUMN published_revision INTEGER CHECK(published_revision IS NULL OR published_revision > 0);
ALTER TABLE edges ADD COLUMN published_revision INTEGER CHECK(published_revision IS NULL OR published_revision > 0);
ALTER TABLE layers ADD COLUMN published_revision INTEGER CHECK(published_revision IS NULL OR published_revision > 0);
ALTER TABLE actions ADD COLUMN published_revision INTEGER CHECK(published_revision IS NULL OR published_revision > 0);

CREATE TABLE completion_states (
    interaction_node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','succeeded','stopped','failed')),
    head_revision INTEGER NOT NULL CHECK(head_revision >= 0),
    current_layer_id INTEGER REFERENCES layers(id),
    final_layer_id INTEGER REFERENCES layers(id),
    safe_reason TEXT,
    temporal_config_version INTEGER NOT NULL DEFAULT 1 CHECK(temporal_config_version > 0),
    temporal_schema_read INTEGER NOT NULL DEFAULT 0 CHECK(temporal_schema_read IN (0,1)),
    temporal_root_current_write INTEGER NOT NULL DEFAULT 0 CHECK(temporal_root_current_write IN (0,1)),
    temporal_projection_ui INTEGER NOT NULL DEFAULT 0 CHECK(temporal_projection_ui IN (0,1)),
    temporal_invoke_resolution INTEGER NOT NULL DEFAULT 0 CHECK(temporal_invoke_resolution IN (0,1)),
    temporal_provider_recursion INTEGER NOT NULL DEFAULT 0 CHECK(temporal_provider_recursion IN (0,1)),
    CHECK((lifecycle = 'succeeded' AND final_layer_id IS NOT NULL AND current_layer_id = final_layer_id)
       OR (lifecycle <> 'succeeded' AND final_layer_id IS NULL)),
    CHECK((lifecycle IN ('stopped','failed') AND safe_reason IS NOT NULL)
       OR (lifecycle IN ('active','succeeded') AND safe_reason IS NULL))
);

CREATE TABLE current_revisions (
    interaction_node_id INTEGER NOT NULL REFERENCES completion_states(interaction_node_id),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    transition TEXT NOT NULL CHECK(transition IN ('initial','advance','return','stop','fail')),
    base_revision INTEGER CHECK(base_revision IS NULL OR base_revision >= 0),
    current_layer_id INTEGER REFERENCES layers(id),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','succeeded','stopped','failed')),
    operation_key TEXT,
    request_digest TEXT,
    snapshot_digest TEXT,
    safe_reason TEXT,
    PRIMARY KEY(interaction_node_id, revision),
    UNIQUE(interaction_node_id, operation_key),
    CHECK((revision = 0 AND transition = 'initial' AND base_revision IS NULL AND operation_key IS NULL)
       OR (revision > 0 AND transition <> 'initial' AND base_revision = revision - 1 AND operation_key IS NOT NULL))
);

CREATE TABLE completion_authorities (
    interaction_node_id INTEGER PRIMARY KEY REFERENCES completion_states(interaction_node_id),
    author_eligible INTEGER NOT NULL CHECK(author_eligible IN (0,1)),
    read_entitlement TEXT NOT NULL,
    read_entitlement_digest TEXT NOT NULL,
    authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK(authority_epoch >= 0)
);

CREATE TABLE graph_projection_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    interaction_node_id INTEGER NOT NULL REFERENCES completion_states(interaction_node_id),
    revision INTEGER NOT NULL,
    event_kind TEXT NOT NULL CHECK(event_kind IN ('initialized','advanced','returned','stopped','failed')),
    UNIQUE(interaction_node_id, revision),
    FOREIGN KEY(interaction_node_id, revision) REFERENCES current_revisions(interaction_node_id, revision)
);

INSERT INTO completion_states(interaction_node_id,lifecycle,head_revision,current_layer_id,final_layer_id)
SELECT completion.interaction_node_id,'succeeded',1,root.target_layer_id,root.target_layer_id
FROM completions completion
JOIN actions root ON root.id=completion.root_action_id
WHERE root.state='accepted' AND root.kind='navigate' AND root.relation='expand' AND root.target_layer_id IS NOT NULL;

INSERT INTO current_revisions(interaction_node_id,revision,transition,base_revision,current_layer_id,lifecycle)
SELECT interaction_node_id,0,'initial',NULL,NULL,'active' FROM completion_states;

INSERT INTO current_revisions(interaction_node_id,revision,transition,base_revision,current_layer_id,lifecycle,operation_key,request_digest,snapshot_digest)
SELECT interaction_node_id,1,'return',0,current_layer_id,'succeeded','legacy-flat-return','legacy-flat-return','legacy-accepted-closure'
FROM completion_states;

INSERT INTO completion_authorities(interaction_node_id,author_eligible,read_entitlement,read_entitlement_digest,authority_epoch)
SELECT interaction_node_id,0,'imported-or-legacy-read-only','legacy',0 FROM completion_states;

INSERT INTO graph_projection_outbox(interaction_node_id,revision,event_kind)
SELECT interaction_node_id,1,'returned' FROM completion_states;

CREATE INDEX graph_projection_outbox_completion ON graph_projection_outbox(interaction_node_id, sequence);

CREATE TABLE temporal_feature_config (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    config_version INTEGER NOT NULL CHECK(config_version > 0),
    schema_read INTEGER NOT NULL CHECK(schema_read IN (0,1)),
    root_current_write INTEGER NOT NULL CHECK(root_current_write IN (0,1)),
    projection_ui INTEGER NOT NULL CHECK(projection_ui IN (0,1)),
    invoke_resolution INTEGER NOT NULL CHECK(invoke_resolution IN (0,1)),
    provider_recursion INTEGER NOT NULL CHECK(provider_recursion IN (0,1))
);

INSERT INTO temporal_feature_config(
    singleton,config_version,schema_read,root_current_write,projection_ui,invoke_resolution,provider_recursion
) VALUES (1,1,0,0,0,0,0);

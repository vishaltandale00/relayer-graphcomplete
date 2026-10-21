CREATE TABLE instruction_graph_versions (
    version_key TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    thread_id INTEGER NOT NULL UNIQUE CHECK(thread_id >= 8000000000000000 AND thread_id <= 8999999999999999),
    interaction_node_id INTEGER UNIQUE REFERENCES nodes(id),
    manifest_json TEXT
);
CREATE TABLE instruction_graph_attachments (
    interaction_node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
    version_key TEXT NOT NULL REFERENCES instruction_graph_versions(version_key)
);
CREATE TRIGGER instruction_graph_inherit AFTER INSERT ON nodes
WHEN NEW.kind='user-interaction' AND NEW.lease_source_interaction_id IS NOT NULL
BEGIN
    INSERT INTO instruction_graph_attachments(interaction_node_id,version_key)
    SELECT NEW.id,version_key FROM instruction_graph_attachments WHERE interaction_node_id=NEW.lease_source_interaction_id;
END;

CREATE TRIGGER instruction_graph_durable_child_inherit AFTER INSERT ON durable_invocations
BEGIN
    INSERT OR IGNORE INTO instruction_graph_attachments(interaction_node_id,version_key)
    SELECT NEW.child_interaction_node_id,version_key FROM instruction_graph_attachments WHERE interaction_node_id=NEW.source_completion_id;
END;

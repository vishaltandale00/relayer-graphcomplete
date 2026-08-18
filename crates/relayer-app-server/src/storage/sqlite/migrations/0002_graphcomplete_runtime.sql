ALTER TABLE threads ADD COLUMN harness_configuration_name TEXT NOT NULL DEFAULT 'codex-basic';

ALTER TABLE interactions ADD COLUMN graph_node_id INTEGER;
ALTER TABLE interactions ADD COLUMN completion_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE interactions ADD COLUMN harness_configuration_name TEXT;
ALTER TABLE interactions ADD COLUMN harness_configuration_digest TEXT;
ALTER TABLE interactions ADD COLUMN completion_output_json TEXT;
ALTER TABLE interactions ADD COLUMN completion_error TEXT;

CREATE UNIQUE INDEX interactions_graph_node
    ON interactions(graph_node_id)
    WHERE graph_node_id IS NOT NULL;

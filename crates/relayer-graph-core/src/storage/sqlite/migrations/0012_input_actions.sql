PRAGMA foreign_keys=OFF;

CREATE TABLE actions_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER CHECK(project_id > 0),
    thread_id INTEGER NOT NULL CHECK(thread_id > 0),
    source_node_id INTEGER NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL CHECK(kind IN ('navigate', 'invoke', 'input')),
    label TEXT NOT NULL,
    target_layer_id INTEGER REFERENCES layers(id),
    interaction_text TEXT,
    response INTEGER NOT NULL DEFAULT 0 CHECK(response IN (0, 1)),
    state TEXT NOT NULL CHECK(state IN ('draft', 'accepted', 'stopped')),
    owner_interaction_id INTEGER NOT NULL REFERENCES nodes(id),
    client_key TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT 'pill' CHECK(variant IN ('chip', 'pill', 'wide', 'card')),
    icon TEXT,
    description TEXT,
    source_layer_id INTEGER REFERENCES layers(id),
    relation TEXT CHECK(relation IN ('expand', 'reference')),
    type_id TEXT NOT NULL DEFAULT 'graph.action' CHECK(type_id IN ('graph.action', 'interaction.context')),
    published_revision INTEGER CHECK(published_revision IS NULL OR published_revision > 0),
    UNIQUE(owner_interaction_id, source_node_id, client_key)
);

INSERT INTO actions_new(
    id,project_id,thread_id,source_node_id,kind,label,target_layer_id,interaction_text,
    response,state,owner_interaction_id,client_key,variant,icon,description,source_layer_id,
    relation,type_id,published_revision
)
SELECT
    id,project_id,thread_id,source_node_id,kind,label,target_layer_id,interaction_text,
    response,state,owner_interaction_id,client_key,variant,icon,description,source_layer_id,
    relation,type_id,published_revision
FROM actions;

DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;

CREATE INDEX actions_source ON actions(project_id, thread_id, source_node_id);
CREATE INDEX actions_source_layer ON actions(owner_interaction_id, source_layer_id);
CREATE INDEX actions_target_relation ON actions(owner_interaction_id, target_layer_id, relation);

CREATE TRIGGER actions_one_active_root_insert
BEFORE INSERT ON actions
WHEN NEW.type_id != 'interaction.context'
  AND NEW.state IN ('draft', 'accepted')
  AND NEW.source_node_id = NEW.owner_interaction_id
  AND NEW.source_layer_id IS NULL
  AND EXISTS (
      SELECT 1 FROM actions existing
      WHERE existing.type_id != 'interaction.context'
        AND existing.owner_interaction_id = NEW.owner_interaction_id
        AND existing.source_node_id = existing.owner_interaction_id
        AND existing.source_layer_id IS NULL
        AND existing.state IN ('draft', 'accepted')
  )
BEGIN
    SELECT RAISE(ABORT, 'root_action_already_exists');
END;

CREATE TRIGGER actions_one_active_root_update
BEFORE UPDATE OF owner_interaction_id, source_node_id, source_layer_id, state, type_id ON actions
WHEN NEW.type_id != 'interaction.context'
  AND NEW.state IN ('draft', 'accepted')
  AND NEW.source_node_id = NEW.owner_interaction_id
  AND NEW.source_layer_id IS NULL
  AND EXISTS (
      SELECT 1 FROM actions existing
      WHERE existing.id <> OLD.id
        AND existing.type_id != 'interaction.context'
        AND existing.owner_interaction_id = NEW.owner_interaction_id
        AND existing.source_node_id = existing.owner_interaction_id
        AND existing.source_layer_id IS NULL
        AND existing.state IN ('draft', 'accepted')
  )
BEGIN
    SELECT RAISE(ABORT, 'root_action_already_exists');
END;

CREATE TABLE input_action_payloads (
    action_id INTEGER PRIMARY KEY REFERENCES actions(id) ON DELETE CASCADE,
    control TEXT NOT NULL CHECK(control IN ('text', 'single_select', 'multi_select')),
    prompt TEXT NOT NULL,
    options_json TEXT NOT NULL,
    minimum_selections INTEGER CHECK(minimum_selections > 0)
);

CREATE VIEW action_records AS
SELECT actions.*,
       input_action_payloads.control AS input_control,
       input_action_payloads.prompt AS input_prompt,
       input_action_payloads.options_json AS input_options_json,
       input_action_payloads.minimum_selections AS input_minimum_selections
FROM actions
LEFT JOIN input_action_payloads ON input_action_payloads.action_id=actions.id;

PRAGMA foreign_keys=ON;

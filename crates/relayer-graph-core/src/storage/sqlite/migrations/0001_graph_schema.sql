CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER CHECK(project_id > 0),
    thread_id INTEGER NOT NULL CHECK(thread_id > 0),
    kind TEXT NOT NULL,
    icon TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('draft', 'accepted', 'stopped')),
    owner_interaction_id INTEGER REFERENCES nodes(id),
    client_key TEXT,
    UNIQUE(owner_interaction_id, client_key)
);

CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER CHECK(project_id > 0),
    thread_id INTEGER NOT NULL CHECK(thread_id > 0),
    left_id INTEGER NOT NULL REFERENCES nodes(id),
    right_id INTEGER NOT NULL REFERENCES nodes(id),
    state TEXT NOT NULL CHECK(state IN ('draft', 'accepted', 'stopped')),
    owner_interaction_id INTEGER NOT NULL REFERENCES nodes(id),
    client_key TEXT NOT NULL,
    UNIQUE(owner_interaction_id, client_key),
    CHECK(left_id < right_id)
);

CREATE TABLE layers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER CHECK(project_id > 0),
    thread_id INTEGER NOT NULL CHECK(thread_id > 0),
    state TEXT NOT NULL CHECK(state IN ('draft', 'accepted', 'stopped')),
    owner_interaction_id INTEGER NOT NULL REFERENCES nodes(id),
    client_key TEXT NOT NULL,
    UNIQUE(owner_interaction_id, client_key)
);

CREATE TABLE layer_nodes (
    layer_id INTEGER NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES nodes(id),
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(layer_id, node_id),
    UNIQUE(layer_id, position)
);

CREATE TABLE layer_edges (
    layer_id INTEGER NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    edge_id INTEGER NOT NULL REFERENCES edges(id),
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(layer_id, edge_id),
    UNIQUE(layer_id, position)
);

CREATE TABLE actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER CHECK(project_id > 0),
    thread_id INTEGER NOT NULL CHECK(thread_id > 0),
    source_node_id INTEGER NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL CHECK(kind IN ('navigate', 'invoke')),
    label TEXT NOT NULL,
    target_layer_id INTEGER REFERENCES layers(id),
    interaction_text TEXT,
    response INTEGER NOT NULL DEFAULT 0 CHECK(response IN (0, 1)),
    state TEXT NOT NULL CHECK(state IN ('draft', 'accepted', 'stopped')),
    owner_interaction_id INTEGER NOT NULL REFERENCES nodes(id),
    client_key TEXT NOT NULL,
    UNIQUE(owner_interaction_id, source_node_id, client_key)
);

CREATE TABLE layer_actions (
    layer_id INTEGER NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    action_id INTEGER NOT NULL REFERENCES actions(id),
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(layer_id, action_id),
    UNIQUE(layer_id, position)
);

CREATE TABLE completions (
    interaction_node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
    root_action_id INTEGER NOT NULL UNIQUE REFERENCES actions(id)
);

CREATE INDEX nodes_project ON nodes(project_id);
CREATE INDEX nodes_thread ON nodes(thread_id);
CREATE INDEX edges_endpoints ON edges(project_id, thread_id, left_id, right_id);
CREATE UNIQUE INDEX accepted_project_edges ON edges(project_id, left_id, right_id)
    WHERE state = 'accepted' AND project_id IS NOT NULL;
CREATE UNIQUE INDEX accepted_standalone_edges ON edges(thread_id, left_id, right_id)
    WHERE state = 'accepted' AND project_id IS NULL;
CREATE INDEX actions_source ON actions(project_id, thread_id, source_node_id);

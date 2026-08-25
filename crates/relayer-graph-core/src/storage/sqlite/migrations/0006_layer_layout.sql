ALTER TABLE layers
    ADD COLUMN layout_schema_version INTEGER
    CHECK(layout_schema_version IS NULL OR layout_schema_version > 0);

CREATE TABLE layer_placements (
    layer_id INTEGER NOT NULL,
    node_id INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    x REAL NOT NULL CHECK(typeof(x) IN ('real', 'integer') AND x >= 0 AND x <= 1),
    y REAL NOT NULL CHECK(typeof(y) IN ('real', 'integer') AND y >= 0 AND y <= 1),
    PRIMARY KEY(layer_id, node_id),
    UNIQUE(layer_id, position),
    FOREIGN KEY(layer_id, node_id) REFERENCES layer_nodes(layer_id, node_id) ON DELETE CASCADE
);

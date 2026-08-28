CREATE TABLE personal_presentation_profiles (
    thread_id INTEGER PRIMARY KEY CHECK(thread_id > 0)
);

CREATE TABLE personal_presentation_versions (
    version_interaction_node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
    profile_thread_id INTEGER NOT NULL REFERENCES personal_presentation_profiles(thread_id),
    root_layer_id INTEGER NOT NULL UNIQUE REFERENCES layers(id),
    retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0, 1))
);

CREATE TABLE personal_presentation_attachments (
    interaction_node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
    version_interaction_node_id INTEGER NOT NULL REFERENCES personal_presentation_versions(version_interaction_node_id),
    root_layer_id INTEGER NOT NULL REFERENCES layers(id),
    UNIQUE(interaction_node_id, version_interaction_node_id),
    UNIQUE(interaction_node_id, root_layer_id)
);

CREATE INDEX personal_presentation_attachment_versions
    ON personal_presentation_attachments(version_interaction_node_id);

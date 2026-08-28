ALTER TABLE threads ADD COLUMN surface TEXT NOT NULL DEFAULT 'conversation'
    CHECK(surface IN ('conversation', 'personal_presentation_profile'));

CREATE UNIQUE INDEX one_personal_presentation_profile_thread
    ON threads(surface)
    WHERE surface='personal_presentation_profile';

CREATE TABLE personal_presentation_versions (
    version_key TEXT PRIMARY KEY NOT NULL,
    profile_interaction_id INTEGER NOT NULL UNIQUE REFERENCES interactions(id) ON DELETE RESTRICT,
    graph_node_id INTEGER UNIQUE,
    root_layer_id INTEGER UNIQUE,
    published_at TEXT,
    retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0, 1)),
    CHECK((graph_node_id IS NULL) = (root_layer_id IS NULL)),
    CHECK((graph_node_id IS NULL) = (published_at IS NULL))
);

ALTER TABLE threads ADD COLUMN personal_presentation_version_key TEXT
    REFERENCES personal_presentation_versions(version_key) ON DELETE RESTRICT;

CREATE TABLE personal_presentation_policy (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
    profile_thread_id INTEGER NOT NULL UNIQUE REFERENCES threads(id) ON DELETE RESTRICT,
    active_version_key TEXT NOT NULL REFERENCES personal_presentation_versions(version_key) ON DELETE RESTRICT
);

CREATE TABLE interaction_personal_presentation_pins (
    interaction_id INTEGER PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
    version_key TEXT NOT NULL REFERENCES personal_presentation_versions(version_key) ON DELETE RESTRICT,
    version_interaction_node_id INTEGER NOT NULL,
    root_layer_id INTEGER NOT NULL,
    pinned_at TEXT NOT NULL
);

INSERT INTO threads(
    id,title,project_id,created_at,updated_at,harness_configuration_name,
    permission_profile_id,conversation_import_id,surface
)
VALUES (
    -1,'Personal presentation profile',NULL,'0','0','codex-basic',
    'auto',NULL,'personal_presentation_profile'
);

INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,permission_profile_id)
VALUES (-1,-1,1,'Personal presentation V0','0','profile_pending','auto');

INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,permission_profile_id)
VALUES (-2,-1,2,'Personal presentation V1','0','profile_pending','auto');

INSERT INTO personal_presentation_versions(version_key,profile_interaction_id)
SELECT 'personal-presentation-v0',i.id
FROM interactions i JOIN threads t ON t.id=i.thread_id
WHERE t.surface='personal_presentation_profile' AND i.sequence=1;

INSERT INTO personal_presentation_versions(version_key,profile_interaction_id)
SELECT 'personal-presentation-v1',i.id
FROM interactions i JOIN threads t ON t.id=i.thread_id
WHERE t.surface='personal_presentation_profile' AND i.sequence=2;

INSERT INTO personal_presentation_policy(singleton,profile_thread_id,active_version_key)
SELECT 1,id,'personal-presentation-v1'
FROM threads WHERE surface='personal_presentation_profile';

CREATE TRIGGER pin_personal_presentation_on_interaction_insert
AFTER INSERT ON interactions
WHEN EXISTS(
    SELECT 1 FROM threads
    WHERE id=NEW.thread_id AND surface='conversation' AND conversation_import_id IS NULL
)
AND EXISTS(
    SELECT 1 FROM personal_presentation_versions
    WHERE graph_node_id IS NOT NULL AND root_layer_id IS NOT NULL
)
BEGIN
    SELECT CASE WHEN NOT EXISTS(
        SELECT 1
        FROM threads thread
        JOIN personal_presentation_policy policy ON policy.singleton=1
        JOIN personal_presentation_versions chosen
          ON chosen.version_key=COALESCE(thread.personal_presentation_version_key,policy.active_version_key)
        WHERE thread.id=NEW.thread_id
          AND chosen.graph_node_id IS NOT NULL
          AND chosen.root_layer_id IS NOT NULL
          AND chosen.retired=0
    ) THEN RAISE(ABORT, 'personal presentation version is unavailable') END;

    INSERT INTO interaction_personal_presentation_pins(
        interaction_id,version_key,version_interaction_node_id,root_layer_id,pinned_at
    )
    SELECT NEW.id,chosen.version_key,chosen.graph_node_id,chosen.root_layer_id,NEW.created_at
    FROM threads thread
    JOIN personal_presentation_policy policy ON policy.singleton=1
    JOIN personal_presentation_versions chosen
      ON chosen.version_key=COALESCE(thread.personal_presentation_version_key,policy.active_version_key)
    WHERE thread.id=NEW.thread_id
      AND chosen.graph_node_id IS NOT NULL
      AND chosen.root_layer_id IS NOT NULL
      AND chosen.retired=0;
END;

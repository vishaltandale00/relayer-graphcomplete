use sqlx::{SqlitePool, migrate::Migrator};

use crate::GraphError;

static MIGRATOR: Migrator = sqlx::migrate!("./src/storage/sqlite/migrations");

pub(crate) async fn run(pool: &SqlitePool) -> Result<(), GraphError> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::MIGRATOR;
    use crate::*;
    use sqlx::{Connection, Row, SqliteConnection, migrate::Migrator, sqlite::SqlitePoolOptions};
    use std::borrow::Cow;

    #[tokio::test]
    async fn schema_9_graph_reopens_and_accepts_a_personal_presentation_attachment() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", file.path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let pre_personal_presentation = Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|migration| migration.version <= 9)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        };
        pre_personal_presentation.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key,input_identity,input_digest) VALUES (1,NULL,1,'user-interaction','user','Legacy','Legacy interaction','accepted',NULL,NULL,'legacy-1','sha256:legacy')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let database = GraphDatabase::open(file.path()).await.unwrap();
        let mut connection = database.storage.acquire().await.unwrap();
        let legacy_title: String = sqlx::query("SELECT title FROM nodes WHERE id=1")
            .fetch_one(&mut *connection)
            .await
            .unwrap()
            .get("title");
        assert_eq!(legacy_title, "Legacy");
        drop(connection);

        let version_text = "Personal presentation version V1";
        let version_digest = interaction_input_digest(version_text, &[]).unwrap();
        let version = database
            .create_personal_presentation_interaction(
                version_text,
                "relayer.personal-presentation:migration-v1",
                &version_digest,
            )
            .await
            .unwrap();
        let writer = database.writer_for_subgraph(version.id).await.unwrap();
        let preference = writer
            .submit_node(&NodeDraft {
                client_key: "decision-useful-center".into(),
                kind: "presentation-preference".into(),
                icon: "compass".into(),
                title: "Decision-useful center".into(),
                detail: "Foreground the conclusion.".into(),
            })
            .await
            .unwrap();
        let root = writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![preference.id],
                edges: vec![],
                layout: Some(LayerLayout::v1(vec![NodePlacement {
                    node_id: preference.id,
                    x: 0.5,
                    y: 0.5,
                }])),
                size_justification: None,
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: version.id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Expand),
                label: "Response".into(),
                variant: ActionVariant::default(),
                icon: None,
                description: None,
                target_layer_id: Some(root.id),
                interaction_text: None,
                input: None,
            })
            .await
            .unwrap();
        writer.complete(version.id).await.unwrap();
        database
            .publish_personal_presentation_version(version.id)
            .await
            .unwrap();
        let target = database
            .create_interaction(None, ThreadId::new(2).unwrap(), "Current interaction")
            .await
            .unwrap();
        let attachment = database
            .attach_personal_presentation(target.id, version.id)
            .await
            .unwrap();
        database.storage.close().await;

        let reopened = GraphDatabase::open(file.path()).await.unwrap();
        let mut connection = reopened.storage.acquire().await.unwrap();
        let preserved: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes WHERE id=1")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        assert_eq!(preserved, 1);
        drop(connection);
        let resolved = reopened
            .personal_presentation_attachment(target.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resolved.attachment, attachment);
        assert_eq!(resolved.graph.root_layer_id, root.id);
    }

    #[tokio::test]
    async fn action_presentation_migration_defaults_existing_actions_to_pill() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("migrations/0001_graph_schema.sql"))
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (1,NULL,1,'user-interaction','user','Question','Question','accepted',NULL,NULL)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO actions(id,project_id,thread_id,source_node_id,kind,label,target_layer_id,interaction_text,response,state,owner_interaction_id,client_key) VALUES (1,NULL,1,1,'invoke','Continue',NULL,'Continue from here',0,'draft',1,'continue')",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        sqlx::raw_sql(include_str!("migrations/0002_action_presentation.sql"))
            .execute(&mut connection)
            .await
            .unwrap();

        let migrated: (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT variant,icon,description FROM actions WHERE id=1")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(migrated, ("pill".into(), None, None));
    }

    #[tokio::test]
    async fn navigation_relation_migration_preserves_legacy_actions() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("migrations/0001_graph_schema.sql"))
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/0002_action_presentation.sql"))
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (1,NULL,1,'user-interaction','user','Question','Question','accepted',NULL,NULL),(2,NULL,1,'concept','box','Answer','Answer','accepted',1,'answer')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO layers(id,project_id,thread_id,state,owner_interaction_id,client_key) VALUES (1,NULL,1,'accepted',1,'root'),(2,NULL,1,'accepted',1,'child')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO actions(id,project_id,thread_id,source_node_id,kind,label,target_layer_id,interaction_text,response,state,owner_interaction_id,client_key) VALUES (1,NULL,1,1,'navigate','Response',1,NULL,1,'accepted',1,'response'),(2,NULL,1,2,'navigate','Details',2,NULL,0,'accepted',1,'details')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query("INSERT INTO layer_actions(layer_id,action_id,position) VALUES (1,2,0)")
            .execute(&mut connection)
            .await
            .unwrap();

        sqlx::raw_sql(include_str!("migrations/0003_navigation_relations.sql"))
            .execute(&mut connection)
            .await
            .unwrap();

        let migrated: Vec<(i64, Option<i64>, Option<String>)> =
            sqlx::query_as("SELECT id,source_layer_id,relation FROM actions ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            migrated,
            vec![
                (1, None, Some("expand".into())),
                (2, Some(1), Some("expand".into())),
            ]
        );
    }

    #[tokio::test]
    async fn layer_layout_migration_preserves_coordinate_free_history() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for migration in [
            include_str!("migrations/0001_graph_schema.sql"),
            include_str!("migrations/0002_action_presentation.sql"),
            include_str!("migrations/0003_navigation_relations.sql"),
            include_str!("migrations/0004_imported_conversations.sql"),
        ] {
            sqlx::raw_sql(migration)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (1,NULL,1,'user-interaction','user','Question','Question','accepted',NULL,NULL),(2,NULL,1,'concept','box','Answer','Answer','accepted',1,'answer')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO layers(id,project_id,thread_id,state,owner_interaction_id,client_key) VALUES (1,NULL,1,'accepted',1,'root')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query("INSERT INTO layer_nodes(layer_id,node_id,position) VALUES (1,2,0)")
            .execute(&mut connection)
            .await
            .unwrap();

        sqlx::raw_sql(include_str!("migrations/0006_layer_layout.sql"))
            .execute(&mut connection)
            .await
            .unwrap();

        let legacy_version: Option<i64> =
            sqlx::query_scalar("SELECT layout_schema_version FROM layers WHERE id=1")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let legacy_placements: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM layer_placements WHERE layer_id=1")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(legacy_version, None);
        assert_eq!(legacy_placements, 0);

        sqlx::query("UPDATE layers SET layout_schema_version=1 WHERE id=1")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO layer_placements(layer_id,node_id,position,x,y) VALUES (1,2,0,0.25,0.75)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let stored: (i64, f64, f64) =
            sqlx::query_as("SELECT node_id,x,y FROM layer_placements WHERE layer_id=1")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(stored, (2, 0.25, 0.75));
    }

    #[tokio::test]
    async fn interaction_lease_migration_preserves_legacy_nodes_and_enforces_one_lease_per_action()
    {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("migrations/0001_graph_schema.sql"))
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/0002_action_presentation.sql"))
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/0003_navigation_relations.sql"))
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (1,1,1,'user-interaction','user','Source','Source','accepted',NULL,NULL),(2,1,2,'user-interaction','user','Legacy','Legacy','accepted',NULL,NULL)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO actions(id,project_id,thread_id,source_node_id,kind,label,target_layer_id,interaction_text,response,state,owner_interaction_id,client_key,variant,source_layer_id,relation) VALUES (1,1,1,1,'invoke','Continue',NULL,'Continue',0,'accepted',1,'continue','pill',NULL,NULL)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "migrations/0005_interaction_action_leases.sql"
        ))
        .execute(&mut connection)
        .await
        .unwrap();

        let legacy: Option<i64> =
            sqlx::query_scalar("SELECT leased_action_id FROM nodes WHERE id=2")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(legacy, None);
        let partial = sqlx::query("UPDATE nodes SET leased_action_id=1 WHERE id=2")
            .execute(&mut connection)
            .await
            .unwrap_err();
        assert!(partial.to_string().contains("CHECK constraint failed"));
        sqlx::query("UPDATE nodes SET leased_action_id=1,lease_source_interaction_id=1 WHERE id=2")
            .execute(&mut connection)
            .await
            .unwrap();
        let duplicate = sqlx::query(
            "INSERT INTO nodes(project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key,leased_action_id,lease_source_interaction_id) VALUES (1,3,'user-interaction','user','Duplicate','Duplicate','accepted',NULL,NULL,1,1)",
        )
        .execute(&mut connection)
        .await
        .unwrap_err();
        assert!(duplicate.to_string().contains("UNIQUE constraint failed"));
    }

    #[tokio::test]
    async fn active_root_guard_preserves_existing_duplicates_and_rejects_new_ones() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for migration in [
            include_str!("migrations/0001_graph_schema.sql"),
            include_str!("migrations/0002_action_presentation.sql"),
            include_str!("migrations/0003_navigation_relations.sql"),
            include_str!("migrations/0004_imported_conversations.sql"),
            include_str!("migrations/0005_interaction_action_leases.sql"),
            include_str!("migrations/0006_layer_layout.sql"),
        ] {
            sqlx::raw_sql(migration)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (1,NULL,1,'user-interaction','user','Question','Question','accepted',NULL,NULL)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        for (id, key) in [(1_i64, "first"), (2, "second")] {
            sqlx::query(
                "INSERT INTO actions(id,project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,target_layer_id,interaction_text,state,owner_interaction_id,client_key) VALUES (?1,NULL,1,1,NULL,'navigate','expand','Response','pill',NULL,NULL,'draft',1,?2)",
            )
            .bind(id)
            .bind(key)
            .execute(&mut connection)
            .await
            .unwrap();
        }

        sqlx::raw_sql(include_str!("migrations/0007_active_root_action_guard.sql"))
            .execute(&mut connection)
            .await
            .unwrap();

        let preserved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM actions WHERE owner_interaction_id=1 AND source_node_id=1",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(preserved, 2);
        let rejected = sqlx::query(
            "INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,target_layer_id,interaction_text,state,owner_interaction_id,client_key) VALUES (NULL,1,1,NULL,'navigate','expand','Response','pill',NULL,NULL,'draft',1,'third')",
        )
        .execute(&mut connection)
        .await
        .unwrap_err();
        assert!(rejected.to_string().contains("root_action_already_exists"));

        sqlx::query("UPDATE actions SET state='stopped'")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,target_layer_id,interaction_text,state,owner_interaction_id,client_key) VALUES (NULL,1,1,NULL,'navigate','expand','Response','pill',NULL,NULL,'draft',1,'third')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let reactivated = sqlx::query("UPDATE actions SET state='draft' WHERE id=1")
            .execute(&mut connection)
            .await
            .unwrap_err();
        assert!(
            reactivated
                .to_string()
                .contains("root_action_already_exists")
        );
    }

    #[tokio::test]
    async fn interaction_context_migration_preserves_legacy_actions_and_root_guard() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for migration in [
            include_str!("migrations/0001_graph_schema.sql"),
            include_str!("migrations/0002_action_presentation.sql"),
            include_str!("migrations/0003_navigation_relations.sql"),
            include_str!("migrations/0004_imported_conversations.sql"),
            include_str!("migrations/0005_interaction_action_leases.sql"),
            include_str!("migrations/0006_layer_layout.sql"),
            include_str!("migrations/0007_active_root_action_guard.sql"),
        ] {
            sqlx::raw_sql(migration)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (1,NULL,1,'user-interaction','user','Source','Source','accepted',NULL,NULL),(2,NULL,1,'concept','box','Target','Target','accepted',1,'target'),(3,NULL,1,'user-interaction','user','Input','Input','accepted',NULL,NULL)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO layers(id,project_id,thread_id,state,owner_interaction_id,client_key) VALUES (1,NULL,1,'accepted',1,'root')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query("INSERT INTO layer_nodes(layer_id,node_id,position) VALUES (1,2,0)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO actions(id,project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,target_layer_id,interaction_text,state,owner_interaction_id,client_key) VALUES (1,NULL,1,1,NULL,'navigate','expand','Response','pill',1,NULL,'accepted',1,'response')",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        sqlx::raw_sql(include_str!(
            "migrations/0008_interaction_context_actions.sql"
        ))
        .execute(&mut connection)
        .await
        .unwrap();

        let legacy_type: String = sqlx::query_scalar("SELECT type_id FROM actions WHERE id=1")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(legacy_type, "graph.action");
        sqlx::query(
            "INSERT INTO actions(id,project_id,thread_id,source_node_id,source_layer_id,kind,label,variant,state,owner_interaction_id,client_key,type_id) VALUES (2,NULL,1,3,NULL,'invoke','','pill','accepted',3,char(0) || 'interaction.context:0','interaction.context')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO interaction_context_actions(action_id,interaction_node_id,target_node_id,source_interaction_node_id,source_layer_id) VALUES (2,3,2,1,1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO actions(id,project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,state,owner_interaction_id,client_key) VALUES (3,NULL,1,3,NULL,'navigate','expand','Response','pill','draft',3,'interaction.context:0')",
        )
        .execute(&mut connection)
        .await
        .expect("public root key must not collide with the internal context identity");
        let duplicate_root = sqlx::query(
            "INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,state,owner_interaction_id,client_key) VALUES (NULL,1,1,NULL,'navigate','expand','Other','pill','draft',1,'other')",
        )
        .execute(&mut connection)
        .await
        .unwrap_err();
        assert!(
            duplicate_root
                .to_string()
                .contains("root_action_already_exists")
        );
        let foreign_key_errors: Vec<(String, i64, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert!(foreign_key_errors.is_empty());
    }

    #[tokio::test]
    async fn interaction_input_children_migration_is_additive_for_existing_databases() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for migration in [
            include_str!("migrations/0001_graph_schema.sql"),
            include_str!("migrations/0002_action_presentation.sql"),
            include_str!("migrations/0003_navigation_relations.sql"),
            include_str!("migrations/0004_imported_conversations.sql"),
            include_str!("migrations/0005_interaction_action_leases.sql"),
            include_str!("migrations/0006_layer_layout.sql"),
            include_str!("migrations/0007_active_root_action_guard.sql"),
            include_str!("migrations/0008_interaction_context_actions.sql"),
            include_str!("migrations/0009_interaction_input_identity.sql"),
            include_str!("migrations/0010_personal_presentation_attachments.sql"),
            include_str!("migrations/0011_input_actions.sql"),
        ] {
            sqlx::raw_sql(migration)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (1,NULL,1,'user-interaction','user','Legacy','Legacy','accepted',NULL,NULL)",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        sqlx::raw_sql(include_str!(
            "migrations/0012_interaction_input_children.sql"
        ))
        .execute(&mut connection)
        .await
        .unwrap();

        let legacy: String = sqlx::query_scalar("SELECT detail FROM nodes WHERE id=1")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        let children: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM interaction_input_children")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(legacy, "Legacy");
        assert_eq!(children, 0);
    }
}

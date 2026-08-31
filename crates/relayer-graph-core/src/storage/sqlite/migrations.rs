use sqlx::{SqliteConnection, SqlitePool, migrate::Migrator};

use crate::{
    GraphError, InteractionContextDraft, InteractionContextTarget, LayerId, NodeId,
    interaction_input_digest,
};

static MIGRATOR: Migrator = sqlx::migrate!("./src/storage/sqlite/migrations");

pub(crate) async fn run(pool: &SqlitePool) -> Result<(), GraphError> {
    let mut connection = pool.acquire().await?;
    let has_migration_history: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations')",
    )
    .fetch_one(&mut *connection)
    .await?;
    let input_actions_pending = if has_migration_history {
        let latest_version: Option<i64> =
            sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success=TRUE")
                .fetch_one(&mut *connection)
                .await?;
        latest_version.is_some_and(|version| version <= 11)
    } else {
        false
    };

    if input_actions_pending {
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut *connection)
            .await?;
    }
    let migration_result = MIGRATOR.run_direct(&mut *connection).await;
    if input_actions_pending {
        let restore_result = sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&mut *connection)
            .await;
        migration_result?;
        restore_result?;
    } else {
        migration_result?;
    }

    let foreign_key_error: Option<(String, i64, String, i64)> =
        sqlx::query_as("PRAGMA foreign_key_check")
            .fetch_optional(&mut *connection)
            .await?;
    if let Some((table, row_id, parent, constraint)) = foreign_key_error {
        return Err(GraphError::Internal(format!(
            "graph migration left an invalid foreign key: table={table} row={row_id} parent={parent} constraint={constraint}"
        )));
    }
    audit_legacy_interaction_input_digests(&mut connection).await?;
    Ok(())
}

async fn audit_legacy_interaction_input_digests(
    connection: &mut SqliteConnection,
) -> Result<(), GraphError> {
    let interactions: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id,detail,input_digest FROM nodes WHERE input_identity IS NOT NULL AND input_digest LIKE 'sha256:v1:%' ORDER BY id",
    )
    .fetch_all(&mut *connection)
    .await?;
    for (interaction_id, detail, stored_digest) in interactions {
        let rows: Vec<(i64, i64, i64, i64, Option<i64>)> = sqlx::query_as(
            "SELECT context.action_id,context.target_node_id,context.source_interaction_node_id,context.source_layer_id,context.position FROM interaction_context_actions context JOIN actions action ON action.id=context.action_id WHERE context.interaction_node_id=?1 AND action.source_node_id=?1 AND action.owner_interaction_id=?1 AND action.type_id='interaction.context' AND action.state='accepted' ORDER BY context.position",
        )
        .bind(interaction_id)
        .fetch_all(&mut *connection)
        .await?;
        let mut contexts = Vec::with_capacity(rows.len());
        for (
            expected_position,
            (action_id, target_node_id, source_interaction_node_id, source_layer_id, position),
        ) in rows.into_iter().enumerate()
        {
            if position != i64::try_from(expected_position).ok() {
                return Err(GraphError::Internal(
                    "stored interaction input does not match its durable digest".into(),
                ));
            }
            let annotations: Vec<String> = sqlx::query_scalar(
                "SELECT text FROM interaction_context_annotations WHERE action_id=?1 ORDER BY position",
            )
            .bind(action_id)
            .fetch_all(&mut *connection)
            .await?;
            let target = InteractionContextTarget {
                node_id: NodeId::new(target_node_id).ok_or_else(|| {
                    GraphError::Internal(
                        "stored interaction input does not match its durable digest".into(),
                    )
                })?,
                source_interaction_node_id: NodeId::new(source_interaction_node_id).ok_or_else(
                    || {
                        GraphError::Internal(
                            "stored interaction input does not match its durable digest".into(),
                        )
                    },
                )?,
                source_layer_id: LayerId::new(source_layer_id).ok_or_else(|| {
                    GraphError::Internal(
                        "stored interaction input does not match its durable digest".into(),
                    )
                })?,
            };
            contexts.push(InteractionContextDraft {
                target,
                annotations,
            });
        }
        let computed_digest = interaction_input_digest(&detail, &contexts).map_err(|error| {
            GraphError::Internal(format!("could not audit stored interaction input: {error}"))
        })?;
        if computed_digest != stored_digest {
            return Err(GraphError::Internal(
                "stored interaction input does not match its durable digest".into(),
            ));
        }
    }
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
    async fn schema_11_graph_reopens_and_tracks_search_index_revisions_and_versions() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", file.path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let pre_search_index = Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|migration| migration.version <= 11)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        };
        pre_search_index.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key,input_identity,input_digest) VALUES (1,7,1,'user-interaction','user','Legacy','Legacy interaction','accepted',NULL,NULL,'legacy-1','sha256:legacy')")
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

        // A target carried across the migration has committed nothing yet, which
        // is distinct from having committed revision zero.
        let project = SearchTarget::new(ProjectId::new(7), ThreadId::new(1).unwrap());
        let thread = SearchTarget::new(None, ThreadId::new(1).unwrap());
        assert_eq!(database.search_index_revision(project).await.unwrap(), None);
        assert_eq!(database.search_index_revision(thread).await.unwrap(), None);
        assert_ne!(project, thread);

        for (component, version) in SearchIndexComponent::ALL.iter().zip([
            "lbug 0.18.0",
            "42",
            "11",
            "relayer.graph-query 1",
            "1",
        ]) {
            database
                .record_search_index_version(*component, version)
                .await
                .unwrap();
        }
        database.storage.close().await;

        // The five versions have to survive a reopen and be readable with no
        // search store present at all, because that is exactly the state they are
        // consulted in: a store that is corrupt or incompatible and will not open.
        let reopened = GraphDatabase::open(file.path()).await.unwrap();
        let versions = tracked_versions(&reopened).await;
        assert_eq!(
            versions,
            vec![
                Some("lbug 0.18.0".to_owned()),
                Some("42".to_owned()),
                Some("11".to_owned()),
                Some("relayer.graph-query 1".to_owned()),
                Some("1".to_owned()),
            ]
        );
        assert!(!file.path().with_extension("ladybug").exists());
    }

    async fn tracked_versions(database: &GraphDatabase) -> Vec<Option<String>> {
        let mut versions = Vec::new();
        for component in SearchIndexComponent::ALL {
            versions.push(database.search_index_version(component).await.unwrap());
        }
        versions
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
    async fn fresh_full_schema_foreign_keys_target_the_current_actions_table() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let database = GraphDatabase::open(file.path()).await.unwrap();
        let mut connection = database.storage.acquire().await.unwrap();
        for (table, action_column) in [
            ("nodes", "leased_action_id"),
            ("layer_actions", "action_id"),
            ("completions", "root_action_id"),
            ("interaction_context_actions", "action_id"),
            ("input_action_payloads", "action_id"),
            ("interaction_input_children", "action_id"),
        ] {
            let foreign_keys: Vec<(String, String)> = sqlx::query_as(&format!(
                "SELECT \"from\",\"table\" FROM pragma_foreign_key_list('{table}') WHERE \"from\"='{action_column}'",
            ))
            .fetch_all(&mut *connection)
            .await
            .unwrap();
            assert_eq!(foreign_keys, vec![(action_column.into(), "actions".into())]);
        }
        let foreign_key_errors: Vec<(String, i64, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(&mut *connection)
                .await
                .unwrap();
        assert!(foreign_key_errors.is_empty());
    }

    #[tokio::test]
    async fn schema_11_actions_rebuild_preserves_all_foreign_key_references() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", file.path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let pre_input_actions = Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|migration| migration.version <= 11)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        };
        pre_input_actions.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key,input_identity,input_digest) VALUES (1,NULL,1,'user-interaction','user','Source','Source','accepted',NULL,NULL,'source','sha256:source'),(2,NULL,1,'concept','box','Answer','Answer','accepted',1,'answer',NULL,NULL),(3,NULL,1,'user-interaction','user','Follow-up','Follow-up','accepted',NULL,NULL,'follow-up','sha256:follow-up')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO layers(id,project_id,thread_id,state,owner_interaction_id,client_key,layout_schema_version) VALUES (1,NULL,1,'accepted',1,'root',NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO layer_nodes(layer_id,node_id,position) VALUES (1,2,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO actions(id,project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,target_layer_id,interaction_text,response,state,owner_interaction_id,client_key,type_id) VALUES (1,NULL,1,1,NULL,'navigate','expand','Response','pill',1,NULL,1,'accepted',1,'response','graph.action'),(2,NULL,1,2,1,'invoke',NULL,'Continue','pill',NULL,'Continue',0,'accepted',1,'continue','graph.action'),(3,NULL,1,3,NULL,'invoke',NULL,'','pill',NULL,NULL,0,'accepted',3,char(0) || 'interaction.context:0','interaction.context')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO layer_actions(layer_id,action_id,position) VALUES (1,2,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO completions(interaction_node_id,root_action_id) VALUES (1,1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO interaction_context_actions(action_id,interaction_node_id,target_node_id,source_interaction_node_id,source_layer_id) VALUES (3,3,2,1,1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO interaction_context_annotations(action_id,position,text) VALUES (3,0,'Preserve this annotation')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE nodes SET leased_action_id=2,lease_source_interaction_id=1 WHERE id=3")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let database = GraphDatabase::open(file.path()).await.unwrap();
        let mut connection = database.storage.acquire().await.unwrap();
        let references: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT action_id FROM layer_actions WHERE layer_id=1),(SELECT root_action_id FROM completions WHERE interaction_node_id=1),(SELECT action_id FROM interaction_context_actions WHERE interaction_node_id=3),(SELECT leased_action_id FROM nodes WHERE id=3)",
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap();
        assert_eq!(references, (2, 1, 3, 2));
        let annotation: String = sqlx::query_scalar(
            "SELECT text FROM interaction_context_annotations WHERE action_id=3 AND position=0",
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap();
        assert_eq!(annotation, "Preserve this annotation");
        let foreign_key_errors: Vec<(String, i64, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(&mut *connection)
                .await
                .unwrap();
        assert!(foreign_key_errors.is_empty());
    }

    #[tokio::test]
    async fn original_schema_12_history_reopens_and_preserves_action_references() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", file.path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let pre_input_actions = Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|migration| migration.version <= 11)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        };
        pre_input_actions.run(&pool).await.unwrap();
        let contexts = [InteractionContextDraft {
            target: InteractionContextTarget {
                node_id: NodeId::new(2).unwrap(),
                source_interaction_node_id: NodeId::new(1).unwrap(),
                source_layer_id: LayerId::new(1).unwrap(),
            },
            annotations: vec!["Preserve this annotation".into()],
        }];
        let input_digest = interaction_input_digest("Compare this", &contexts).unwrap();
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key,input_identity,input_digest) VALUES (1,NULL,1,'user-interaction','user','Source','Source','accepted',NULL,NULL,NULL,NULL),(2,NULL,1,'concept','box','Answer','Answer','accepted',1,'answer',NULL,NULL),(3,NULL,1,'user-interaction','user','Compare this','Compare this','accepted',NULL,NULL,'product:41',?1)",
        )
        .bind(&input_digest)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO layers(id,project_id,thread_id,state,owner_interaction_id,client_key,layout_schema_version) VALUES (1,NULL,1,'accepted',1,'root',NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO layer_nodes(layer_id,node_id,position) VALUES (1,2,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO actions(id,project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,target_layer_id,interaction_text,response,state,owner_interaction_id,client_key,type_id) VALUES (1,NULL,1,2,1,'invoke',NULL,'Continue','pill',NULL,'Continue',0,'accepted',1,'continue','graph.action'),(2,NULL,1,3,NULL,'invoke',NULL,'','pill',NULL,NULL,0,'accepted',3,char(0) || 'interaction.context:0','interaction.context')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO layer_actions(layer_id,action_id,position) VALUES (1,1,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE actions SET published_revision=7 WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO interaction_context_actions(action_id,interaction_node_id,target_node_id,source_interaction_node_id,source_layer_id,position) VALUES (2,3,2,1,1,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO interaction_context_annotations(action_id,position,text) VALUES (2,0,'Preserve this annotation')",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/0012_input_actions.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&pool)
            .await
            .unwrap();
        let input_actions_checksum = MIGRATOR
            .iter()
            .find(|migration| migration.version == 12)
            .unwrap()
            .checksum
            .as_ref();
        sqlx::query(
            "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (12,'input actions',TRUE,?1,0)",
        )
        .bind(input_actions_checksum)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let database = GraphDatabase::open(file.path()).await.unwrap();
        let mut connection = database.storage.acquire().await.unwrap();
        let action_id: i64 =
            sqlx::query_scalar("SELECT action_id FROM layer_actions WHERE layer_id=1")
                .fetch_one(&mut *connection)
                .await
                .unwrap();
        assert_eq!(action_id, 1);
        let published_revision: i64 =
            sqlx::query_scalar("SELECT published_revision FROM actions WHERE id=1")
                .fetch_one(&mut *connection)
                .await
                .unwrap();
        assert_eq!(published_revision, 7);
        let context_action_id: i64 = sqlx::query_scalar(
            "SELECT action_id FROM interaction_context_actions WHERE interaction_node_id=3",
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap();
        assert_eq!(context_action_id, 2);
        let foreign_key_errors: Vec<(String, i64, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(&mut *connection)
                .await
                .unwrap();
        assert!(foreign_key_errors.is_empty());
    }

    #[tokio::test]
    async fn cascade_damaged_schema_12_history_is_rejected_on_open() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", file.path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let pre_input_actions = Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|migration| migration.version <= 11)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        };
        pre_input_actions.run(&pool).await.unwrap();
        let contexts = [InteractionContextDraft {
            target: InteractionContextTarget {
                node_id: NodeId::new(2).unwrap(),
                source_interaction_node_id: NodeId::new(1).unwrap(),
                source_layer_id: LayerId::new(1).unwrap(),
            },
            annotations: vec!["Preserve this annotation".into()],
        }];
        let input_digest = interaction_input_digest("Compare this", &contexts).unwrap();
        sqlx::query(
            "INSERT INTO nodes(id,project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key,input_identity,input_digest) VALUES (1,NULL,1,'user-interaction','user','Source','Source','accepted',NULL,NULL,NULL,NULL),(2,NULL,1,'concept','box','Target','Target','accepted',1,'target',NULL,NULL),(3,NULL,1,'user-interaction','user','Compare this','Compare this','accepted',NULL,NULL,'product:41',?1)",
        )
        .bind(&input_digest)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO layers(id,project_id,thread_id,state,owner_interaction_id,client_key,layout_schema_version) VALUES (1,NULL,1,'accepted',1,'root',NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO layer_nodes(layer_id,node_id,position) VALUES (1,2,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO actions(id,project_id,thread_id,source_node_id,source_layer_id,kind,label,variant,state,owner_interaction_id,client_key,type_id) VALUES (1,NULL,1,3,NULL,'invoke','','pill','accepted',3,char(0) || 'interaction.context:0','interaction.context')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO interaction_context_actions(action_id,interaction_node_id,target_node_id,source_interaction_node_id,source_layer_id,position) VALUES (1,3,2,1,1,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO interaction_context_annotations(action_id,position,text) VALUES (1,0,'Preserve this annotation')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let exact_old_runner = Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|migration| migration.version <= 12)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        };
        exact_old_runner.run(&pool).await.unwrap();
        let lost_contexts: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM interaction_context_actions")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            lost_contexts, 0,
            "fixture must reproduce the destructive predecessor"
        );
        pool.close().await;

        let error = GraphDatabase::open(file.path()).await.err().unwrap();
        assert!(
            error
                .to_string()
                .contains("stored interaction input does not match its durable digest"),
            "{error}"
        );
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
            include_str!("migrations/0011_temporal_completions.sql"),
            include_str!("migrations/0012_input_actions.sql"),
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
            "migrations/0013_interaction_input_children.sql"
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

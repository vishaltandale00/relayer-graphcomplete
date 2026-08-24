use sqlx::{SqlitePool, migrate::Migrator};

use crate::GraphError;

static MIGRATOR: Migrator = sqlx::migrate!("./src/storage/sqlite/migrations");

pub(crate) async fn run(pool: &SqlitePool) -> Result<(), GraphError> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::{Connection, SqliteConnection};

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

        sqlx::raw_sql(include_str!("migrations/0005_layer_layout.sql"))
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
}

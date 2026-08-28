use sqlx::{FromRow, QueryBuilder, Sqlite, SqliteConnection};

use crate::{
    CompletionLifecycle, CompletionState, CurrentProjectionEvent, CurrentTransitionReceipt,
    GraphError, LayerId, NodeId, TemporalFeatureConfig,
};

pub(crate) struct CurrentTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

pub(crate) struct RevisionInsert<'a> {
    pub interaction: NodeId,
    pub revision: u64,
    pub transition: &'a str,
    pub base_revision: u64,
    pub current_layer_id: Option<LayerId>,
    pub lifecycle: CompletionLifecycle,
    pub operation_key: &'a str,
    pub request_digest: &'a str,
    pub snapshot_digest: &'a str,
    pub safe_reason: Option<&'a str>,
}

pub(crate) struct HeadMove<'a> {
    pub interaction: NodeId,
    pub expected_revision: u64,
    pub revision: u64,
    pub lifecycle: CompletionLifecycle,
    pub current_layer_id: Option<LayerId>,
    pub final_layer_id: Option<LayerId>,
    pub safe_reason: Option<&'a str>,
}

#[derive(FromRow)]
struct StateRow {
    interaction_node_id: i64,
    lifecycle: String,
    head_revision: i64,
    current_layer_id: Option<i64>,
    final_layer_id: Option<i64>,
    safe_reason: Option<String>,
    temporal_config_version: i64,
    temporal_schema_read: bool,
    temporal_root_current_write: bool,
    temporal_projection_ui: bool,
    temporal_invoke_resolution: bool,
    temporal_provider_recursion: bool,
}

#[derive(FromRow)]
struct ReceiptRow {
    interaction_node_id: i64,
    revision: i64,
    lifecycle: String,
    current_layer_id: Option<i64>,
    operation_key: String,
    request_digest: String,
    snapshot_digest: String,
    sequence: i64,
}

#[derive(FromRow)]
struct ProjectionRow {
    sequence: i64,
    interaction_node_id: i64,
    revision: i64,
    base_revision: Option<i64>,
    lifecycle: String,
    current_layer_id: Option<i64>,
    final_layer_id: Option<i64>,
    safe_reason: Option<String>,
}

#[derive(FromRow)]
struct TemporalFeatureRow {
    config_version: i64,
    schema_read: bool,
    root_current_write: bool,
    projection_ui: bool,
    invoke_resolution: bool,
    provider_recursion: bool,
}

impl<'connection> CurrentTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn temporal_features(&mut self) -> Result<TemporalFeatureConfig, GraphError> {
        let row = sqlx::query_as::<_, TemporalFeatureRow>(
            "SELECT config_version,schema_read,root_current_write,projection_ui,invoke_resolution,provider_recursion FROM temporal_feature_config WHERE singleton=1",
        )
        .fetch_one(&mut *self.connection)
        .await?;
        Ok(TemporalFeatureConfig {
            config_version: u32::try_from(row.config_version).map_err(|_| {
                GraphError::Internal("database returned invalid temporal config version".into())
            })?,
            schema_read: row.schema_read,
            root_current_write: row.root_current_write,
            projection_ui: row.projection_ui,
            invoke_resolution: row.invoke_resolution,
            provider_recursion: row.provider_recursion,
        })
    }

    pub(crate) async fn set_temporal_features(
        &mut self,
        config: TemporalFeatureConfig,
    ) -> Result<(), GraphError> {
        if config.config_version != 1 {
            return Err(GraphError::validation(
                "unsupported_temporal_config_version",
                "configVersion",
                "Temporal feature config version must be 1.",
            ));
        }
        if config.root_current_write && !config.schema_read {
            return Err(GraphError::validation(
                "invalid_temporal_feature_dependency",
                "rootCurrentWrite",
                "Root current writes require schema reads.",
            ));
        }
        if config.projection_ui && (!config.schema_read || !config.root_current_write) {
            return Err(GraphError::validation(
                "invalid_temporal_feature_dependency",
                "projectionUi",
                "Projection UI requires schema reads and root current writes.",
            ));
        }
        if config.invoke_resolution && !config.projection_ui {
            return Err(GraphError::validation(
                "invalid_temporal_feature_dependency",
                "invokeResolution",
                "Invoke resolution requires projection UI.",
            ));
        }
        if config.provider_recursion && !config.invoke_resolution {
            return Err(GraphError::validation(
                "invalid_temporal_feature_dependency",
                "providerRecursion",
                "Provider recursion requires invoke resolution.",
            ));
        }
        sqlx::query(
            "UPDATE temporal_feature_config SET config_version=?1,schema_read=?2,root_current_write=?3,projection_ui=?4,invoke_resolution=?5,provider_recursion=?6 WHERE singleton=1",
        )
        .bind(i64::from(config.config_version))
        .bind(config.schema_read)
        .bind(config.root_current_write)
        .bind(config.projection_ui)
        .bind(config.invoke_resolution)
        .bind(config.provider_recursion)
        .execute(&mut *self.connection)
        .await?;
        Ok(())
    }

    pub(crate) async fn initialize(
        &mut self,
        interaction: NodeId,
        author_eligible: bool,
        read_entitlement: &str,
        entitlement_digest: &str,
    ) -> Result<(), GraphError> {
        let inserted = sqlx::query(
            r#"
            INSERT OR IGNORE INTO completion_states(
                interaction_node_id,lifecycle,head_revision,current_layer_id,final_layer_id,
                temporal_config_version,temporal_schema_read,temporal_root_current_write,
                temporal_projection_ui,temporal_invoke_resolution,temporal_provider_recursion
            )
            SELECT ?1,'active',0,NULL,NULL,config_version,schema_read,root_current_write,
                   projection_ui,invoke_resolution,provider_recursion
              FROM temporal_feature_config WHERE singleton=1
            "#,
        )
        .bind(interaction.value())
        .execute(&mut *self.connection)
        .await?
        .rows_affected();
        if inserted == 0 {
            return Ok(());
        }
        sqlx::query(
            "INSERT INTO current_revisions(interaction_node_id,revision,transition,base_revision,current_layer_id,lifecycle) VALUES (?1,0,'initial',NULL,NULL,'active')",
        )
        .bind(interaction.value())
        .execute(&mut *self.connection)
        .await?;
        sqlx::query(
            "INSERT INTO completion_authorities(interaction_node_id,author_eligible,read_entitlement,read_entitlement_digest,authority_epoch) VALUES (?1,?2,?3,?4,0)",
        )
        .bind(interaction.value())
        .bind(author_eligible)
        .bind(read_entitlement)
        .bind(entitlement_digest)
        .execute(&mut *self.connection)
        .await?;
        sqlx::query(
            "INSERT INTO graph_projection_outbox(interaction_node_id,revision,event_kind) VALUES (?1,0,'initialized')",
        )
        .bind(interaction.value())
        .execute(&mut *self.connection)
        .await?;
        Ok(())
    }

    pub(crate) async fn activate_authority(
        &mut self,
        interaction: NodeId,
    ) -> Result<u64, GraphError> {
        let epoch: Option<i64> = sqlx::query_scalar(
            r#"
            UPDATE completion_authorities
               SET authority_epoch=authority_epoch+1
             WHERE interaction_node_id=?1
               AND author_eligible=1
               AND EXISTS(
                   SELECT 1 FROM completion_states state
                    WHERE state.interaction_node_id=?1 AND state.lifecycle='active'
               )
            RETURNING authority_epoch
            "#,
        )
        .bind(interaction.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        epoch
            .map(|value| as_u64(value, "authority epoch"))
            .transpose()?
            .ok_or_else(|| {
                GraphError::validation(
                    "terminal_completion",
                    "completion",
                    "Only an active author-eligible completion can activate execution authority.",
                )
            })
    }

    pub(crate) async fn cutover_authority(
        &mut self,
        interaction: NodeId,
    ) -> Result<(), GraphError> {
        let changed = sqlx::query(
            "UPDATE completion_authorities SET authority_epoch=authority_epoch+1 WHERE interaction_node_id=?1 AND author_eligible=1",
        )
        .bind(interaction.value())
        .execute(&mut *self.connection)
        .await?
        .rows_affected();
        if changed == 1 {
            Ok(())
        } else {
            Err(GraphError::Forbidden(
                "completion authority is not eligible for broker cutover".into(),
            ))
        }
    }

    pub(crate) async fn validate_authority(
        &mut self,
        interaction: NodeId,
        epoch: u64,
        read_entitlement: &str,
        entitlement_digest: &str,
    ) -> Result<(), GraphError> {
        let valid: i64 = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                  FROM completion_authorities authority
                  JOIN completion_states state
                    ON state.interaction_node_id=authority.interaction_node_id
                 WHERE authority.interaction_node_id=?1
                   AND authority.author_eligible=1
                   AND authority.authority_epoch=?2
                   AND authority.read_entitlement=?3
                   AND authority.read_entitlement_digest=?4
                   AND state.lifecycle='active'
            )
            "#,
        )
        .bind(interaction.value())
        .bind(as_i64(epoch, "authority epoch")?)
        .bind(read_entitlement)
        .bind(entitlement_digest)
        .fetch_one(&mut *self.connection)
        .await?;
        if valid == 1 {
            Ok(())
        } else {
            Err(GraphError::validation(
                "authority_generation_expired",
                "authority",
                "This completion broker generation is expired or terminal.",
            ))
        }
    }

    pub(crate) async fn validate_generation(
        &mut self,
        interaction: NodeId,
        epoch: u64,
        read_entitlement: &str,
        entitlement_digest: &str,
    ) -> Result<(), GraphError> {
        let valid: i64 = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                  FROM completion_authorities
                 WHERE interaction_node_id=?1
                   AND author_eligible=1
                   AND authority_epoch=?2
                   AND read_entitlement=?3
                   AND read_entitlement_digest=?4
            )
            "#,
        )
        .bind(interaction.value())
        .bind(as_i64(epoch, "authority epoch")?)
        .bind(read_entitlement)
        .bind(entitlement_digest)
        .fetch_one(&mut *self.connection)
        .await?;
        if valid == 1 {
            Ok(())
        } else {
            Err(GraphError::validation(
                "authority_generation_expired",
                "authority",
                "This completion broker generation is expired.",
            ))
        }
    }

    pub(crate) async fn state(
        &mut self,
        interaction: NodeId,
    ) -> Result<CompletionState, GraphError> {
        let row = sqlx::query_as::<_, StateRow>(
            "SELECT interaction_node_id,lifecycle,head_revision,current_layer_id,final_layer_id,safe_reason,temporal_config_version,temporal_schema_read,temporal_root_current_write,temporal_projection_ui,temporal_invoke_resolution,temporal_provider_recursion FROM completion_states WHERE interaction_node_id=?1",
        )
        .bind(interaction.value())
        .fetch_optional(&mut *self.connection)
        .await?
        .ok_or_else(|| GraphError::NotFound(format!("completion {interaction}")))?;
        state_from_row(row)
    }

    pub(crate) async fn states_for(
        &mut self,
        interactions: &[NodeId],
    ) -> Result<Vec<CompletionState>, GraphError> {
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT interaction_node_id,lifecycle,head_revision,current_layer_id,final_layer_id,safe_reason,temporal_config_version,temporal_schema_read,temporal_root_current_write,temporal_projection_ui,temporal_invoke_resolution,temporal_provider_recursion FROM completion_states WHERE interaction_node_id IN (",
        );
        let mut separated = query.separated(",");
        for interaction in interactions {
            separated.push_bind(interaction.value());
        }
        separated.push_unseparated(") ORDER BY interaction_node_id");
        query
            .build_query_as::<StateRow>()
            .fetch_all(&mut *self.connection)
            .await?
            .into_iter()
            .map(state_from_row)
            .collect()
    }

    pub(crate) async fn receipt(
        &mut self,
        interaction: NodeId,
        operation_key: &str,
    ) -> Result<Option<CurrentTransitionReceipt>, GraphError> {
        sqlx::query_as::<_, ReceiptRow>(
            r#"
            SELECT revision.interaction_node_id,revision.revision,revision.lifecycle,
                   revision.current_layer_id,revision.operation_key,revision.request_digest,
                   revision.snapshot_digest,outbox.sequence
            FROM current_revisions revision
            JOIN graph_projection_outbox outbox
              ON outbox.interaction_node_id=revision.interaction_node_id
             AND outbox.revision=revision.revision
            WHERE revision.interaction_node_id=?1 AND revision.operation_key=?2
            "#,
        )
        .bind(interaction.value())
        .bind(operation_key)
        .fetch_optional(&mut *self.connection)
        .await?
        .map(receipt_from_row)
        .transpose()
    }

    pub(crate) async fn append_revision(
        &mut self,
        input: RevisionInsert<'_>,
    ) -> Result<(), GraphError> {
        sqlx::query(
            r#"
            INSERT INTO current_revisions(
                interaction_node_id,revision,transition,base_revision,current_layer_id,lifecycle,
                operation_key,request_digest,snapshot_digest,safe_reason
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
            "#,
        )
        .bind(input.interaction.value())
        .bind(as_i64(input.revision, "revision")?)
        .bind(input.transition)
        .bind(as_i64(input.base_revision, "base revision")?)
        .bind(input.current_layer_id.map(LayerId::value))
        .bind(input.lifecycle.as_str())
        .bind(input.operation_key)
        .bind(input.request_digest)
        .bind(input.snapshot_digest)
        .bind(input.safe_reason)
        .execute(&mut *self.connection)
        .await?;
        Ok(())
    }

    pub(crate) async fn move_head(&mut self, input: HeadMove<'_>) -> Result<bool, GraphError> {
        Ok(sqlx::query(
            "UPDATE completion_states SET lifecycle=?1,head_revision=?2,current_layer_id=?3,final_layer_id=?4,safe_reason=?5 WHERE interaction_node_id=?6 AND lifecycle='active' AND head_revision=?7",
        )
        .bind(input.lifecycle.as_str())
        .bind(as_i64(input.revision, "revision")?)
        .bind(input.current_layer_id.map(LayerId::value))
        .bind(input.final_layer_id.map(LayerId::value))
        .bind(input.safe_reason)
        .bind(input.interaction.value())
        .bind(as_i64(input.expected_revision, "expected revision")?)
        .execute(&mut *self.connection)
        .await?
        .rows_affected()
            == 1)
    }

    pub(crate) async fn append_projection(
        &mut self,
        interaction: NodeId,
        revision: u64,
        event_kind: &str,
    ) -> Result<u64, GraphError> {
        let result = sqlx::query(
            "INSERT INTO graph_projection_outbox(interaction_node_id,revision,event_kind) VALUES (?1,?2,?3)",
        )
        .bind(interaction.value())
        .bind(as_i64(revision, "revision")?)
        .bind(event_kind)
        .execute(&mut *self.connection)
        .await?;
        as_u64(result.last_insert_rowid(), "projection sequence")
    }

    pub(crate) async fn projections_after(
        &mut self,
        after_sequence: u64,
        limit: u32,
    ) -> Result<Vec<CurrentProjectionEvent>, GraphError> {
        let rows = sqlx::query_as::<_, ProjectionRow>(
            r#"
            SELECT outbox.sequence,outbox.interaction_node_id,outbox.revision,revision.base_revision,revision.lifecycle,
                   revision.current_layer_id,
                   CASE WHEN revision.lifecycle='succeeded' THEN revision.current_layer_id END AS final_layer_id,
                   revision.safe_reason
            FROM graph_projection_outbox outbox
            JOIN current_revisions revision
              ON revision.interaction_node_id=outbox.interaction_node_id
             AND revision.revision=outbox.revision
            JOIN completion_states state
              ON state.interaction_node_id=outbox.interaction_node_id
             AND state.temporal_projection_ui=1
            WHERE outbox.sequence>?1 ORDER BY outbox.sequence LIMIT ?2
            "#,
        )
        .bind(as_i64(after_sequence, "projection cursor")?)
        .bind(i64::from(limit))
        .fetch_all(&mut *self.connection)
        .await?;
        rows.into_iter().map(projection_from_row).collect()
    }

    pub(crate) async fn projections_after_for(
        &mut self,
        interactions: &[NodeId],
        after_sequence: u64,
        limit: u32,
    ) -> Result<Vec<CurrentProjectionEvent>, GraphError> {
        let mut query = QueryBuilder::<Sqlite>::new(
            r#"
            SELECT outbox.sequence,outbox.interaction_node_id,outbox.revision,revision.base_revision,revision.lifecycle,
                   revision.current_layer_id,
                   CASE WHEN revision.lifecycle='succeeded' THEN revision.current_layer_id END AS final_layer_id,
                   revision.safe_reason
            FROM graph_projection_outbox outbox
            JOIN current_revisions revision
              ON revision.interaction_node_id=outbox.interaction_node_id
             AND revision.revision=outbox.revision
            WHERE outbox.sequence>
            "#,
        );
        query.push_bind(as_i64(after_sequence, "projection cursor")?);
        query.push(" AND outbox.interaction_node_id IN (");
        let mut separated = query.separated(",");
        for interaction in interactions {
            separated.push_bind(interaction.value());
        }
        separated.push_unseparated(") ORDER BY outbox.sequence LIMIT ");
        query.push_bind(i64::from(limit));
        query
            .build_query_as::<ProjectionRow>()
            .fetch_all(&mut *self.connection)
            .await?
            .into_iter()
            .map(projection_from_row)
            .collect()
    }
}

fn state_from_row(row: StateRow) -> Result<CompletionState, GraphError> {
    Ok(CompletionState {
        completion_id: valid_node_id(row.interaction_node_id)?,
        lifecycle: CompletionLifecycle::parse(&row.lifecycle)?,
        head_revision: as_u64(row.head_revision, "completion revision")?,
        current_layer_id: row.current_layer_id.map(valid_layer_id).transpose()?,
        final_layer_id: row.final_layer_id.map(valid_layer_id).transpose()?,
        safe_reason: row.safe_reason,
        temporal_features: TemporalFeatureConfig {
            config_version: u32::try_from(row.temporal_config_version).map_err(|_| {
                GraphError::Internal("database returned invalid temporal config version".into())
            })?,
            schema_read: row.temporal_schema_read,
            root_current_write: row.temporal_root_current_write,
            projection_ui: row.temporal_projection_ui,
            invoke_resolution: row.temporal_invoke_resolution,
            provider_recursion: row.temporal_provider_recursion,
        },
    })
}

fn receipt_from_row(row: ReceiptRow) -> Result<CurrentTransitionReceipt, GraphError> {
    let lifecycle = CompletionLifecycle::parse(&row.lifecycle)?;
    let current_layer_id = row.current_layer_id.map(valid_layer_id).transpose()?;
    Ok(CurrentTransitionReceipt {
        completion_id: valid_node_id(row.interaction_node_id)?,
        revision: as_u64(row.revision, "completion revision")?,
        lifecycle,
        current_layer_id,
        final_layer_id: (lifecycle == CompletionLifecycle::Succeeded)
            .then_some(current_layer_id)
            .flatten(),
        operation_key: row.operation_key,
        request_digest: row.request_digest,
        snapshot_digest: row.snapshot_digest,
        projection_sequence: as_u64(row.sequence, "projection sequence")?,
    })
}

fn projection_from_row(row: ProjectionRow) -> Result<CurrentProjectionEvent, GraphError> {
    Ok(CurrentProjectionEvent {
        sequence: as_u64(row.sequence, "projection sequence")?,
        completion_id: valid_node_id(row.interaction_node_id)?,
        revision: as_u64(row.revision, "completion revision")?,
        previous_revision: row
            .base_revision
            .map(|value| as_u64(value, "previous completion revision"))
            .transpose()?,
        lifecycle: CompletionLifecycle::parse(&row.lifecycle)?,
        current_layer_id: row.current_layer_id.map(valid_layer_id).transpose()?,
        final_layer_id: row.final_layer_id.map(valid_layer_id).transpose()?,
        safe_reason: row.safe_reason,
    })
}

fn valid_node_id(value: i64) -> Result<NodeId, GraphError> {
    NodeId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned invalid node ID".into()))
}

fn valid_layer_id(value: i64) -> Result<LayerId, GraphError> {
    LayerId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned invalid layer ID".into()))
}

fn as_u64(value: i64, name: &str) -> Result<u64, GraphError> {
    u64::try_from(value)
        .map_err(|_| GraphError::Internal(format!("database returned invalid {name}")))
}

fn as_i64(value: u64, name: &str) -> Result<i64, GraphError> {
    i64::try_from(value).map_err(|_| {
        GraphError::validation("invalid_revision", name, format!("{name} is too large"))
    })
}

use sqlx::{FromRow, SqliteConnection};

use crate::{
    ActionDraft, ActionId, ActionKind, ActionVariant, GraphAction, GraphError, InputAction,
    InputControl, InputOption, LayerId, NavigateRelation, NodeId, ProjectId, RecordState,
    graph::InteractionScope,
};

pub(crate) struct ActionTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

pub(crate) struct ActionRecord {
    pub action: GraphAction,
}

pub(crate) struct RootActionIdentity {
    pub id: ActionId,
    pub client_key: String,
}

#[derive(FromRow)]
struct ActionRow {
    id: i64,
    source_node_id: i64,
    source_layer_id: Option<i64>,
    kind: String,
    relation: Option<String>,
    label: String,
    variant: String,
    icon: Option<String>,
    description: Option<String>,
    target_layer_id: Option<i64>,
    interaction_text: Option<String>,
    input_control: Option<String>,
    input_prompt: Option<String>,
    input_options_json: Option<String>,
    input_minimum_selections: Option<i64>,
    state: String,
}

impl<'connection> ActionTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn record(
        &mut self,
        scope: &InteractionScope,
        id: ActionId,
    ) -> Result<Option<ActionRecord>, GraphError> {
        sqlx::query_as::<_, ActionRow>(
            "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,input_control,input_prompt,input_options_json,input_minimum_selections,state FROM action_records WHERE id=?1 AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3))",
        )
        .bind(id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_optional(&mut *self.connection)
        .await?
        .map(ActionRecord::try_from)
        .transpose()
    }

    pub(crate) async fn authored_accepted(
        &mut self,
        scope: &InteractionScope,
        id: ActionId,
    ) -> Result<Option<ActionRecord>, GraphError> {
        sqlx::query_as::<_, ActionRow>(
            "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state FROM actions WHERE id=?1 AND owner_interaction_id=?2 AND state='accepted' AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4))",
        )
        .bind(id.value())
        .bind(scope.root_node_id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_optional(&mut *self.connection)
        .await?
        .map(ActionRecord::try_from)
        .transpose()
    }

    pub(crate) async fn for_source(
        &mut self,
        scope: &InteractionScope,
        source: NodeId,
        owner: Option<NodeId>,
        accepted_only: bool,
    ) -> Result<Vec<ActionRecord>, GraphError> {
        let rows = match (owner, accepted_only) {
            (Some(owner), _) => sqlx::query_as::<_, ActionRow>(
                "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,input_control,input_prompt,input_options_json,input_minimum_selections,state FROM action_records WHERE source_node_id=?1 AND owner_interaction_id=?2 AND type_id!='interaction.context' AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4)) ORDER BY id",
            )
            .bind(source.value())
            .bind(owner.value())
            .bind(scope.project_id.map(ProjectId::value))
            .bind(scope.thread_id.value())
            .fetch_all(&mut *self.connection)
            .await?,
            (None, true) => sqlx::query_as::<_, ActionRow>(
                "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,input_control,input_prompt,input_options_json,input_minimum_selections,state FROM action_records WHERE source_node_id=?1 AND type_id!='interaction.context' AND state='accepted' AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3)) ORDER BY id",
            )
            .bind(source.value())
            .bind(scope.project_id.map(ProjectId::value))
            .bind(scope.thread_id.value())
            .fetch_all(&mut *self.connection)
            .await?,
            (None, false) => sqlx::query_as::<_, ActionRow>(
                "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,input_control,input_prompt,input_options_json,input_minimum_selections,state FROM action_records WHERE source_node_id=?1 AND type_id!='interaction.context' AND (state='accepted' OR owner_interaction_id=?2) AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4)) ORDER BY id",
            )
            .bind(source.value())
            .bind(scope.root_node_id.value())
            .bind(scope.project_id.map(ProjectId::value))
            .bind(scope.thread_id.value())
            .fetch_all(&mut *self.connection)
            .await?,
        };
        rows.into_iter().map(ActionRecord::try_from).collect()
    }

    pub(crate) async fn by_owner_and_key(
        &mut self,
        owner: NodeId,
        source: NodeId,
        client_key: &str,
    ) -> Result<Option<ActionRecord>, GraphError> {
        sqlx::query_as::<_, ActionRow>(
            "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,input_control,input_prompt,input_options_json,input_minimum_selections,state FROM action_records WHERE owner_interaction_id=?1 AND source_node_id=?2 AND client_key=?3 AND type_id!='interaction.context'",
        )
        .bind(owner.value())
        .bind(source.value())
        .bind(client_key)
        .fetch_optional(&mut *self.connection)
        .await?
        .map(ActionRecord::try_from)
        .transpose()
    }

    pub(crate) async fn active_root_identity(
        &mut self,
        owner: NodeId,
    ) -> Result<Option<RootActionIdentity>, GraphError> {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT id,client_key FROM actions WHERE owner_interaction_id=?1 AND source_node_id=?1 AND type_id!='interaction.context' AND source_layer_id IS NULL AND state IN ('draft','accepted') ORDER BY id LIMIT 1",
        )
        .bind(owner.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        row.map(|(id, client_key)| {
            Ok(RootActionIdentity {
                id: valid_action_id(id)?,
                client_key,
            })
        })
        .transpose()
    }

    pub(crate) async fn for_source_layer(
        &mut self,
        scope: &InteractionScope,
        layer: LayerId,
    ) -> Result<Vec<ActionRecord>, GraphError> {
        sqlx::query_as::<_, ActionRow>(
            "SELECT id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,input_control,input_prompt,input_options_json,input_minimum_selections,state FROM action_records WHERE owner_interaction_id=?1 AND type_id!='interaction.context' AND source_layer_id=?2 AND ((?3 IS NOT NULL AND project_id=?3) OR (?3 IS NULL AND project_id IS NULL AND thread_id=?4)) ORDER BY id",
        )
        .bind(scope.root_node_id.value())
        .bind(layer.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_all(&mut *self.connection)
        .await?
        .into_iter()
        .map(ActionRecord::try_from)
        .collect()
    }

    pub(crate) async fn relations_for_owned_target(
        &mut self,
        owner: NodeId,
        target: LayerId,
    ) -> Result<Vec<NavigateRelation>, GraphError> {
        sqlx::query_scalar::<_, String>(
            "SELECT relation FROM actions WHERE owner_interaction_id=?1 AND kind='navigate' AND target_layer_id=?2 AND relation IS NOT NULL ORDER BY id",
        )
        .bind(owner.value())
        .bind(target.value())
        .fetch_all(&mut *self.connection)
        .await?
        .into_iter()
        .map(|relation| NavigateRelation::parse(&relation))
        .collect()
    }

    pub(crate) async fn validate_unresolved_lease(
        &mut self,
        scope: &InteractionScope,
        source_interaction: NodeId,
        action_id: ActionId,
    ) -> Result<(), GraphError> {
        let in_source_completion = sqlx::query_scalar::<_, i64>(
            r#"
            WITH RECURSIVE reachable_layers(id) AS (
                SELECT root.target_layer_id
                FROM completions completion
                JOIN actions root ON root.id=completion.root_action_id
                WHERE completion.interaction_node_id=?1
                  AND root.state='accepted'
                  AND root.target_layer_id IS NOT NULL
                UNION
                SELECT revision.current_layer_id
                FROM current_revisions revision
                JOIN completion_states current
                  ON current.interaction_node_id=revision.interaction_node_id
                WHERE revision.interaction_node_id=?1
                  AND current.temporal_provider_recursion=1
                  AND revision.current_layer_id IS NOT NULL
                UNION
                SELECT child.target_layer_id
                FROM reachable_layers reachable
                JOIN layer_actions membership ON membership.layer_id=reachable.id
                JOIN actions child ON child.id=membership.action_id
                WHERE child.state='accepted'
                  AND child.kind='navigate'
                  AND child.target_layer_id IS NOT NULL
            )
            SELECT EXISTS(
                SELECT 1
                FROM nodes source
                JOIN actions leased ON leased.id=?2
                WHERE source.id=?1
                  AND source.kind='user-interaction'
                  AND source.state='accepted'
                  AND source.owner_interaction_id IS NULL
                  -- A semantic child outlives its parent, so it can return while that parent
                  -- is still running and has no final completion of its own yet. Its lease
                  -- then names an occurrence published in one of the parent's revisions.
                  AND (EXISTS(SELECT 1 FROM completions WHERE interaction_node_id=source.id)
                       OR EXISTS(
                           SELECT 1 FROM completion_states current
                           WHERE current.interaction_node_id=source.id
                             AND current.temporal_provider_recursion=1
                       ))
                  AND ((?3 IS NOT NULL AND source.project_id=?3)
                       OR (?3 IS NULL AND source.project_id IS NULL AND source.thread_id=?4))
                  AND (leased.id=(
                      SELECT completion.root_action_id
                      FROM completions completion
                      WHERE completion.interaction_node_id=?1
                  ) OR EXISTS(
                      SELECT 1
                      FROM reachable_layers reachable
                      JOIN layer_actions membership ON membership.layer_id=reachable.id
                      WHERE membership.action_id=leased.id
                  ))
            )
            "#,
        )
        .bind(source_interaction.value())
        .bind(action_id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_one(&mut *self.connection)
        .await?;
        if in_source_completion == 0 {
            return Err(GraphError::validation(
                "invalid_invoke_lease",
                "interactionNode.leasedActionId",
                "The interaction lease no longer identifies an action in its exact accepted source completion.",
            ));
        }
        let action = self
            .record(scope, action_id)
            .await?
            .ok_or_else(|| {
                GraphError::validation(
                    "invalid_invoke_lease",
                    "interactionNode.leasedActionId",
                    "The interaction lease action is not visible in this graph scope.",
                )
            })?
            .action;
        if action.state != RecordState::Accepted || action.kind != ActionKind::Invoke {
            return Err(GraphError::validation(
                "invalid_invoke_lease",
                "interactionNode.leasedActionId",
                "The interaction lease must identify an accepted invoke action.",
            ));
        }
        if action.target_layer_id.is_some() {
            return Err(GraphError::validation(
                "invoke_lease_already_consumed",
                "interactionNode.leasedActionId",
                "The leased invoke action already has a result target and cannot be redirected.",
            ));
        }
        Ok(())
    }

    pub(crate) async fn resolve_leased_invoke(
        &mut self,
        action_id: ActionId,
        target_layer_id: LayerId,
    ) -> Result<(), GraphError> {
        let result = sqlx::query(
            "UPDATE actions SET target_layer_id=?1 WHERE id=?2 AND state='accepted' AND kind='invoke' AND target_layer_id IS NULL",
        )
        .bind(target_layer_id.value())
        .bind(action_id.value())
        .execute(&mut *self.connection)
        .await?;
        if result.rows_affected() != 1 {
            return Err(GraphError::validation(
                "invoke_lease_already_consumed",
                "interactionNode.leasedActionId",
                "The leased invoke action was already resolved or is no longer eligible for resolution.",
            ));
        }
        Ok(())
    }

    pub(crate) async fn insert_draft(
        &mut self,
        scope: &InteractionScope,
        draft: &ActionDraft,
    ) -> Result<GraphAction, GraphError> {
        let result = sqlx::query(
            "INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'draft',?13,?14)",
        )
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .bind(draft.source_node_id.value())
        .bind(draft.source_layer_id.map(LayerId::value))
        .bind(draft.kind.as_str())
        .bind(draft.relation.map(NavigateRelation::as_str))
        .bind(&draft.label)
        .bind(draft.variant.as_str())
        .bind(&draft.icon)
        .bind(&draft.description)
        .bind(draft.target_layer_id.map(LayerId::value))
        .bind(&draft.interaction_text)
        .bind(scope.root_node_id.value())
        .bind(&draft.client_key)
        .execute(&mut *self.connection)
        .await?;
        let id = valid_action_id(result.last_insert_rowid())?;
        self.replace_input_payload(id, draft.input.as_ref()).await?;
        Ok(draft_action(id, draft))
    }

    pub(crate) async fn update_draft(
        &mut self,
        id: ActionId,
        draft: &ActionDraft,
    ) -> Result<GraphAction, GraphError> {
        sqlx::query("UPDATE actions SET source_node_id=?1,source_layer_id=?2,kind=?3,relation=?4,label=?5,variant=?6,icon=?7,description=?8,target_layer_id=?9,interaction_text=?10 WHERE id=?11")
            .bind(draft.source_node_id.value())
            .bind(draft.source_layer_id.map(LayerId::value))
            .bind(draft.kind.as_str())
            .bind(draft.relation.map(NavigateRelation::as_str))
            .bind(&draft.label)
            .bind(draft.variant.as_str())
            .bind(&draft.icon)
            .bind(&draft.description)
            .bind(draft.target_layer_id.map(LayerId::value))
            .bind(&draft.interaction_text)
            .bind(id.value())
            .execute(&mut *self.connection)
            .await?;
        self.replace_input_payload(id, draft.input.as_ref()).await?;
        Ok(draft_action(id, draft))
    }

    async fn replace_input_payload(
        &mut self,
        id: ActionId,
        input: Option<&InputAction>,
    ) -> Result<(), GraphError> {
        sqlx::query("DELETE FROM input_action_payloads WHERE action_id=?1")
            .bind(id.value())
            .execute(&mut *self.connection)
            .await?;
        if let Some(input) = input {
            sqlx::query("INSERT INTO input_action_payloads(action_id,control,prompt,options_json,minimum_selections) VALUES (?1,?2,?3,?4,?5)")
                .bind(id.value())
                .bind(input.control.as_str())
                .bind(&input.prompt)
                .bind(serde_json::to_string(&input.options).map_err(|error| GraphError::Internal(error.to_string()))?)
                .bind(input.minimum_selections.map(|value| value as i64))
                .execute(&mut *self.connection)
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn publish_owned(
        &mut self,
        id: ActionId,
        owner: NodeId,
        revision: Option<u64>,
    ) -> Result<(), GraphError> {
        let revision = revision
            .map(|value| {
                i64::try_from(value).map_err(|_| {
                    GraphError::Internal("completion revision exceeds SQLite range".into())
                })
            })
            .transpose()?;
        sqlx::query("UPDATE actions SET state='accepted',published_revision=COALESCE(published_revision,?3) WHERE id=?1 AND owner_interaction_id=?2")
            .bind(id.value())
            .bind(owner.value())
            .bind(revision)
            .execute(&mut *self.connection)
            .await?;
        Ok(())
    }
}

impl TryFrom<ActionRow> for ActionRecord {
    type Error = GraphError;

    fn try_from(row: ActionRow) -> Result<Self, Self::Error> {
        let input = match (
            row.input_control,
            row.input_prompt,
            row.input_options_json,
            row.input_minimum_selections,
        ) {
            (None, None, None, None) => None,
            (Some(control), Some(prompt), Some(options), minimum) => Some(InputAction {
                control: InputControl::parse(&control)?,
                prompt,
                options: serde_json::from_str::<Vec<InputOption>>(&options)
                    .map_err(|error: serde_json::Error| GraphError::Internal(error.to_string()))?,
                minimum_selections: minimum
                    .map(|value| {
                        usize::try_from(value)
                            .map_err(|error| GraphError::Internal(error.to_string()))
                    })
                    .transpose()?,
            }),
            _ => {
                return Err(GraphError::Internal(
                    "database returned a partial input action payload".into(),
                ));
            }
        };
        Ok(Self {
            action: GraphAction {
                id: valid_action_id(row.id)?,
                source_node_id: valid_node_id(row.source_node_id)?,
                source_layer_id: row.source_layer_id.map(valid_layer_id).transpose()?,
                kind: ActionKind::parse(&row.kind)?,
                relation: row
                    .relation
                    .as_deref()
                    .map(NavigateRelation::parse)
                    .transpose()?,
                label: row.label,
                variant: ActionVariant::parse(&row.variant)?,
                icon: row.icon,
                description: row.description,
                target_layer_id: row.target_layer_id.map(valid_layer_id).transpose()?,
                interaction_text: row.interaction_text,
                input,
                state: RecordState::parse(&row.state)?,
            },
        })
    }
}

fn draft_action(id: ActionId, draft: &ActionDraft) -> GraphAction {
    GraphAction {
        id,
        source_node_id: draft.source_node_id,
        source_layer_id: draft.source_layer_id,
        kind: draft.kind,
        relation: draft.relation,
        label: draft.label.clone(),
        variant: draft.variant.clone(),
        icon: draft.icon.clone(),
        description: draft.description.clone(),
        target_layer_id: draft.target_layer_id,
        interaction_text: draft.interaction_text.clone(),
        input: draft.input.clone(),
        state: RecordState::Draft,
    }
}

fn valid_action_id(value: i64) -> Result<ActionId, GraphError> {
    ActionId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid action ID".into()))
}

fn valid_node_id(value: i64) -> Result<NodeId, GraphError> {
    NodeId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid node ID".into()))
}

fn valid_layer_id(value: i64) -> Result<LayerId, GraphError> {
    LayerId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid layer ID".into()))
}

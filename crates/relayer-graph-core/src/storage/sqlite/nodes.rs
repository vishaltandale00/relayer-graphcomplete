use sqlx::{FromRow, SqliteConnection};

use crate::{
    ActionId, ActionKind, AuthoredDetailUpdate, GraphError, GraphNode, InteractionInvocation,
    NodeDraft, NodeId, ProjectId, RecordState, ThreadId, graph::InteractionScope,
};

pub(crate) struct NodeTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

pub(crate) struct NodeRecord {
    pub node: GraphNode,
    pub owner: Option<NodeId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InteractionLease {
    pub source_interaction_id: NodeId,
    pub action_id: ActionId,
}

#[derive(FromRow)]
struct NodeRow {
    id: i64,
    client_key: Option<String>,
    leased_action_id: Option<i64>,
    kind: String,
    icon: String,
    title: String,
    detail: String,
    authored_detail: Option<String>,
    state: String,
    owner_interaction_id: Option<i64>,
}

#[derive(FromRow)]
struct InteractionScopeRow {
    project_id: Option<i64>,
    thread_id: i64,
    kind: String,
    state: String,
    owner_interaction_id: Option<i64>,
    imported: i64,
}

impl<'connection> NodeTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn interaction_lease(
        &mut self,
        interaction_id: NodeId,
    ) -> Result<Option<InteractionLease>, GraphError> {
        #[derive(FromRow)]
        struct LeaseRow {
            leased_action_id: Option<i64>,
            lease_source_interaction_id: Option<i64>,
        }

        let row = sqlx::query_as::<_, LeaseRow>(
            "SELECT leased_action_id,lease_source_interaction_id FROM nodes WHERE id=?1 AND kind='user-interaction' AND state='accepted' AND owner_interaction_id IS NULL",
        )
        .bind(interaction_id.value())
        .fetch_optional(&mut *self.connection)
        .await?
        .ok_or_else(|| GraphError::NotFound(format!("interaction node {interaction_id}")))?;
        match (row.leased_action_id, row.lease_source_interaction_id) {
            (None, None) => Ok(None),
            (Some(action_id), Some(source_interaction_id)) => Ok(Some(InteractionLease {
                source_interaction_id: valid_node_id(source_interaction_id)?,
                action_id: valid_action_id(action_id)?,
            })),
            _ => Err(GraphError::Internal(
                "interaction lease identity is only partially populated".into(),
            )),
        }
    }

    pub(crate) async fn insert_interaction(
        &mut self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        invocation: Option<InteractionInvocation>,
    ) -> Result<GraphNode, GraphError> {
        let mut canonical_text = text.to_owned();
        if let Some(invocation) = invocation {
            if let Some((existing, stored_source_interaction_id)) = self
                .interaction_by_leased_action(invocation.source_action_id)
                .await?
            {
                if stored_source_interaction_id != invocation.source_interaction_node_id {
                    return Err(GraphError::validation(
                        "invocation_action_already_leased",
                        "invocation.sourceActionId",
                        "This invoke action already leased a result interaction from a different source completion.",
                    ));
                }
                self.validate_lease_source(project_id, thread_id, invocation, true)
                    .await?;
                return Ok(existing);
            }
            canonical_text = self
                .validate_lease_source(project_id, thread_id, invocation, false)
                .await?;
        }
        let result = sqlx::query(
            "INSERT INTO nodes(project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key,leased_action_id,lease_source_interaction_id) VALUES (?1,?2,'user-interaction','user',?3,?3,'accepted',NULL,NULL,?4,?5)",
        )
        .bind(project_id.map(ProjectId::value))
        .bind(thread_id.value())
        .bind(&canonical_text)
        .bind(invocation.map(|value| value.source_action_id.value()))
        .bind(invocation.map(|value| value.source_interaction_node_id.value()))
        .execute(&mut *self.connection)
        .await?;
        Ok(GraphNode {
            id: valid_node_id(result.last_insert_rowid())?,
            client_key: None,
            leased_action_id: invocation.map(|value| value.source_action_id),
            kind: "user-interaction".into(),
            icon: "user".into(),
            title: canonical_text.clone(),
            detail: canonical_text,
            authored_detail: None,
            state: RecordState::Accepted,
        })
    }

    pub(crate) async fn identified_interaction(
        &mut self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        input_identity: &str,
        input_digest: &str,
    ) -> Result<Option<GraphNode>, GraphError> {
        let row = sqlx::query_as::<_, NodeRow>(
            "SELECT id,client_key,leased_action_id,kind,icon,title,detail,authored_detail,state,owner_interaction_id FROM nodes WHERE thread_id=?1 AND input_identity=?2",
        ).bind(thread_id.value()).bind(input_identity).fetch_optional(&mut *self.connection).await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let (stored_project_id, stored_digest): (Option<i64>, String) =
            sqlx::query_as("SELECT project_id,input_digest FROM nodes WHERE id=?1")
                .bind(row.id)
                .fetch_one(&mut *self.connection)
                .await?;
        if stored_project_id != project_id.map(ProjectId::value) {
            return Err(GraphError::validation(
                "interaction_input_conflict",
                "projectId",
                "This interaction input identity belongs to a different project or standalone scope.",
            ));
        }
        if stored_digest != input_digest {
            return Err(GraphError::validation(
                "interaction_input_conflict",
                "inputDigest",
                "This interaction input identity was already used with different content.",
            ));
        }
        Ok(Some(NodeRecord::try_from(row)?.node))
    }

    pub(crate) async fn interaction_input_identity(
        &mut self,
        node_id: NodeId,
    ) -> Result<Option<(String, String)>, GraphError> {
        let value = sqlx::query_as("SELECT input_identity,input_digest FROM nodes WHERE id=?1")
            .bind(node_id.value())
            .fetch_optional(&mut *self.connection)
            .await?
            .ok_or_else(|| GraphError::NotFound(format!("interaction node {node_id}")))?;
        match value {
            (None, None) => Ok(None),
            (Some(identity), Some(digest)) => Ok(Some((identity, digest))),
            _ => Err(GraphError::Internal(
                "interaction input identity is partially populated".into(),
            )),
        }
    }

    pub(crate) async fn set_input_identity(
        &mut self,
        node_id: NodeId,
        input_identity: &str,
        input_digest: &str,
    ) -> Result<(), GraphError> {
        sqlx::query("UPDATE nodes SET input_identity=?1,input_digest=?2 WHERE id=?3 AND input_identity IS NULL")
            .bind(input_identity).bind(input_digest).bind(node_id.value()).execute(&mut *self.connection).await?;
        Ok(())
    }

    async fn interaction_by_leased_action(
        &mut self,
        action_id: ActionId,
    ) -> Result<Option<(GraphNode, NodeId)>, GraphError> {
        let source_interaction_id = sqlx::query_scalar::<_, i64>(
            "SELECT lease_source_interaction_id FROM nodes WHERE leased_action_id=?1",
        )
        .bind(action_id.value())
        .fetch_optional(&mut *self.connection)
        .await?
        .map(valid_node_id)
        .transpose()?;
        let Some(source_interaction_id) = source_interaction_id else {
            return Ok(None);
        };
        let node = self.fetch_optional(
            "SELECT id,client_key,leased_action_id,kind,icon,title,detail,authored_detail,state,owner_interaction_id FROM nodes WHERE leased_action_id=?1",
            action_id.value(),
            None,
        )
        .await?
        .ok_or_else(|| GraphError::Internal("leased interaction disappeared during read".into()))?
        .node;
        Ok(Some((node, source_interaction_id)))
    }

    async fn validate_lease_source(
        &mut self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        invocation: InteractionInvocation,
        allow_existing_lease: bool,
    ) -> Result<String, GraphError> {
        #[derive(FromRow)]
        struct LeaseSourceRow {
            project_id: Option<i64>,
            thread_id: i64,
            action_kind: String,
            target_layer_id: Option<i64>,
            action_state: String,
            interaction_text: Option<String>,
            in_completion: i64,
        }

        let row = sqlx::query_as::<_, LeaseSourceRow>(
            r#"
            WITH RECURSIVE presentation_roots(id) AS (
                SELECT root.target_layer_id
                FROM completions completion
                JOIN actions root ON root.id=completion.root_action_id
                WHERE completion.interaction_node_id=?1
                  AND root.state='accepted'
                  AND root.target_layer_id IS NOT NULL
                UNION
                SELECT current.current_layer_id
                FROM completion_states current
                WHERE current.interaction_node_id=?1
                  AND current.lifecycle='active'
                  AND current.temporal_provider_recursion=1
                  AND current.current_layer_id IS NOT NULL
                UNION
                SELECT revision.current_layer_id
                FROM current_revisions revision
                JOIN completion_states current
                  ON current.interaction_node_id=revision.interaction_node_id
                WHERE revision.interaction_node_id=?1
                  AND current.temporal_provider_recursion=1
                  AND revision.current_layer_id IS NOT NULL
                  AND ?3=1
            ), reachable_layers(id) AS (
                SELECT id FROM presentation_roots
                UNION
                SELECT child.target_layer_id
                FROM reachable_layers reachable
                JOIN layer_actions membership ON membership.layer_id=reachable.id
                JOIN actions child ON child.id=membership.action_id
                WHERE child.state='accepted'
                  AND child.kind='navigate'
                  AND child.target_layer_id IS NOT NULL
            )
            SELECT source.project_id,source.thread_id,
                   action.kind AS action_kind,action.target_layer_id,action.state AS action_state,
                   action.interaction_text,
                   EXISTS(
                       SELECT 1
                       FROM reachable_layers reachable
                       JOIN layer_actions membership ON membership.layer_id=reachable.id
                       WHERE membership.action_id=action.id
                   ) AS in_completion
            FROM nodes source
            JOIN actions action ON action.id=?2
            WHERE source.id=?1
              AND source.kind='user-interaction'
              AND source.state='accepted'
              AND source.owner_interaction_id IS NULL
              AND (EXISTS(SELECT 1 FROM completions WHERE interaction_node_id=source.id)
                   OR EXISTS(
                       SELECT 1 FROM completion_states current
                       WHERE current.interaction_node_id=source.id
                         AND current.lifecycle='active'
                         AND current.temporal_provider_recursion=1
                         AND current.current_layer_id IS NOT NULL
                   )
                   OR (?3=1 AND EXISTS(
                       SELECT 1 FROM completion_states current
                       WHERE current.interaction_node_id=source.id
                         AND current.temporal_provider_recursion=1
                   )))
            "#,
        )
        .bind(invocation.source_interaction_node_id.value())
        .bind(invocation.source_action_id.value())
        .bind(i64::from(allow_existing_lease))
        .fetch_optional(&mut *self.connection)
        .await?;
        let Some(row) = row else {
            return Err(GraphError::validation(
                "invalid_invocation_source",
                "invocation",
                "The invocation source must identify a terminal completion or provider-recursion-enabled active current and its published action.",
            ));
        };
        let source_project_id = row.project_id.map(valid_project_id).transpose()?;
        let source_thread_id = valid_thread_id(row.thread_id)?;
        if source_project_id != project_id
            || (project_id.is_none() && source_thread_id != thread_id)
        {
            return Err(GraphError::validation(
                "incompatible_invocation_scope",
                "invocation.sourceInteractionNodeId",
                "The invocation source is outside the result interaction's graph visibility scope.",
            ));
        }
        if row.in_completion == 0 {
            return Err(GraphError::validation(
                "action_not_in_source_completion",
                "invocation.sourceActionId",
                "The source action is not a member of that interaction's published presentation.",
            ));
        }
        if ActionKind::parse(&row.action_kind)? != ActionKind::Invoke
            || RecordState::parse(&row.action_state)? != RecordState::Accepted
        {
            return Err(GraphError::validation(
                "invalid_invocation_action",
                "invocation.sourceActionId",
                "The source action must be an accepted invoke action.",
            ));
        }
        if row.target_layer_id.is_some() && !allow_existing_lease {
            return Err(GraphError::validation(
                "resolved_invocation_action",
                "invocation.sourceActionId",
                "The source invoke action is already resolved.",
            ));
        }
        row.interaction_text.ok_or_else(|| {
            GraphError::Internal(
                "accepted invoke action is missing canonical interaction text".into(),
            )
        })
    }

    pub(crate) async fn interaction_scope(
        &mut self,
        node_id: NodeId,
    ) -> Result<InteractionScope, GraphError> {
        let row = sqlx::query_as::<_, InteractionScopeRow>(
            "SELECT n.project_id,n.thread_id,n.kind,n.state,n.owner_interaction_id,EXISTS(SELECT 1 FROM graph_imports gi WHERE gi.thread_id=n.thread_id) AS imported FROM nodes n WHERE n.id=?1",
        )
        .bind(node_id.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        match row {
            Some(row)
                if row.kind == "user-interaction"
                    && row.state == "accepted"
                    && row.owner_interaction_id.is_none() =>
            {
                Ok(InteractionScope {
                    project_id: row.project_id.map(valid_project_id).transpose()?,
                    thread_id: valid_thread_id(row.thread_id)?,
                    root_node_id: node_id,
                    read_only: row.imported != 0,
                    authority_epoch: None,
                })
            }
            _ => Err(GraphError::Forbidden(
                "graph writer requires an accepted user-interaction node".into(),
            )),
        }
    }

    pub(crate) async fn accepted_project_threads(
        &mut self,
        project_id: ProjectId,
    ) -> Result<Vec<ThreadId>, GraphError> {
        let thread_ids = sqlx::query_scalar::<_, i64>(
            "SELECT DISTINCT thread_id FROM nodes WHERE project_id=?1 AND kind='user-interaction' AND state='accepted' AND owner_interaction_id IS NULL ORDER BY thread_id",
        )
        .bind(project_id.value())
        .fetch_all(&mut *self.connection)
        .await?;
        thread_ids.into_iter().map(valid_thread_id).collect()
    }

    pub(crate) async fn by_owner_and_key(
        &mut self,
        owner: NodeId,
        client_key: &str,
    ) -> Result<Option<NodeRecord>, GraphError> {
        self.fetch_optional(
            "SELECT id,client_key,leased_action_id,kind,icon,title,detail,authored_detail,state,owner_interaction_id FROM nodes WHERE owner_interaction_id=?1 AND client_key=?2",
            owner.value(),
            Some(client_key),
        )
        .await
    }

    pub(crate) async fn visible(
        &mut self,
        scope: &InteractionScope,
        id: NodeId,
    ) -> Result<GraphNode, GraphError> {
        let row = sqlx::query_as::<_, NodeRow>(
            "SELECT id,client_key,leased_action_id,kind,icon,title,detail,authored_detail,state,owner_interaction_id FROM nodes WHERE id=?1 AND ((?2 IS NOT NULL AND project_id=?2) OR (?2 IS NULL AND project_id IS NULL AND thread_id=?3))",
        )
        .bind(id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_optional(&mut *self.connection)
        .await?;
        match row.map(NodeRecord::try_from).transpose()? {
            Some(record)
                if record.node.state == RecordState::Accepted
                    || (record.node.state == RecordState::Draft
                        && record.owner == Some(scope.root_node_id)) =>
            {
                Ok(record.node)
            }
            Some(_) => Err(GraphError::Forbidden(format!(
                "node {id} is not readable by this interaction"
            ))),
            None => {
                let exists = sqlx::query_scalar::<_, i64>("SELECT 1 FROM nodes WHERE id=?1")
                    .bind(id.value())
                    .fetch_optional(&mut *self.connection)
                    .await?
                    .is_some();
                if exists {
                    Err(GraphError::Forbidden(format!(
                        "node {id} is not readable by this interaction"
                    )))
                } else {
                    Err(GraphError::NotFound(format!("node {id}")))
                }
            }
        }
    }

    pub(crate) async fn record(&mut self, id: NodeId) -> Result<Option<NodeRecord>, GraphError> {
        self.fetch_optional(
            "SELECT id,client_key,leased_action_id,kind,icon,title,detail,authored_detail,state,owner_interaction_id FROM nodes WHERE id=?1",
            id.value(),
            None,
        )
        .await
    }

    pub(crate) async fn insert_draft(
        &mut self,
        scope: &InteractionScope,
        draft: &NodeDraft,
        authored_detail: Option<&serde_json::Value>,
    ) -> Result<GraphNode, GraphError> {
        let authored_detail = authored_detail
            .map(serde_json::to_string)
            .transpose()
            .expect("serde_json::Value must serialize");
        let result = sqlx::query(
            "INSERT INTO nodes(project_id,thread_id,kind,icon,title,detail,authored_detail,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,?4,?5,?6,?7,'draft',?8,?9)",
        )
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .bind(&draft.kind)
        .bind(&draft.icon)
        .bind(&draft.title)
        .bind(&draft.detail)
        .bind(&authored_detail)
        .bind(scope.root_node_id.value())
        .bind(&draft.client_key)
        .execute(&mut *self.connection)
        .await?;
        Ok(draft_node(
            valid_node_id(result.last_insert_rowid())?,
            draft,
            authored_detail.as_deref(),
        ))
    }

    pub(crate) async fn update_draft(
        &mut self,
        id: NodeId,
        draft: &NodeDraft,
        authored_detail: AuthoredDetailUpdate<'_>,
    ) -> Result<GraphNode, GraphError> {
        let retain = matches!(authored_detail, AuthoredDetailUpdate::Retain);
        let replacement = authored_detail
            .replacement()
            .map(serde_json::to_string)
            .transpose()
            .expect("serde_json::Value must serialize");
        sqlx::query(
            "UPDATE nodes SET kind=?1,icon=?2,title=?3,detail=?4,authored_detail=CASE WHEN ?5 THEN authored_detail ELSE ?6 END WHERE id=?7",
        )
        .bind(&draft.kind)
        .bind(&draft.icon)
        .bind(&draft.title)
        .bind(&draft.detail)
        .bind(retain)
        .bind(&replacement)
        .bind(id.value())
        .execute(&mut *self.connection)
        .await?;
        self.record(id)
            .await?
            .map(|record| record.node)
            .ok_or_else(|| GraphError::NotFound(format!("node {id}")))
    }

    pub(crate) async fn neighbors(
        &mut self,
        scope: &InteractionScope,
        id: NodeId,
    ) -> Result<Vec<GraphNode>, GraphError> {
        let rows = sqlx::query_as::<_, NodeRow>(
            r#"
            SELECT n.id,n.client_key,n.leased_action_id,n.kind,n.icon,n.title,n.detail,n.authored_detail,n.state,n.owner_interaction_id
            FROM edges e
            JOIN nodes n ON n.id = CASE WHEN e.left_id = ?1 THEN e.right_id ELSE e.left_id END
            WHERE e.state='accepted'
              AND (e.left_id=?1 OR e.right_id=?1)
              AND n.state='accepted'
              AND ((?2 IS NOT NULL AND e.project_id=?2) OR (?2 IS NULL AND e.project_id IS NULL AND e.thread_id=?3))
            ORDER BY n.id
            "#,
        )
        .bind(id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_all(&mut *self.connection)
        .await?;
        let mut nodes = rows
            .into_iter()
            .map(NodeRecord::try_from)
            .map(|record| record.map(|record| record.node))
            .collect::<Result<Vec<_>, _>>()?;
        let derived = sqlx::query_as::<_, NodeRow>(
            r#"
            SELECT source.id,source.client_key,source.leased_action_id,source.kind,source.icon,source.title,
                   source.detail,source.authored_detail,source.state,source.owner_interaction_id
            FROM nodes interaction
            JOIN actions leased ON leased.id=interaction.leased_action_id
            JOIN nodes source ON source.id=leased.source_node_id
            WHERE interaction.id=?1
              AND source.state='accepted'
              AND ((?2 IS NOT NULL AND source.project_id=?2)
                   OR (?2 IS NULL AND source.project_id IS NULL AND source.thread_id=?3))
            "#,
        )
        .bind(id.value())
        .bind(scope.project_id.map(ProjectId::value))
        .bind(scope.thread_id.value())
        .fetch_optional(&mut *self.connection)
        .await?
        .map(NodeRecord::try_from)
        .transpose()?
        .map(|record| record.node);
        if let Some(derived) = derived
            && !nodes.iter().any(|node| node.id == derived.id)
        {
            nodes.push(derived);
        }
        nodes.sort_by_key(|node| node.id);
        Ok(nodes)
    }

    pub(crate) async fn publish_owned(
        &mut self,
        id: NodeId,
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
        sqlx::query("UPDATE nodes SET state='accepted',published_revision=COALESCE(published_revision,?3) WHERE id=?1 AND owner_interaction_id=?2")
            .bind(id.value())
            .bind(owner.value())
            .bind(revision)
            .execute(&mut *self.connection)
            .await?;
        Ok(())
    }

    async fn fetch_optional(
        &mut self,
        sql: &str,
        first: i64,
        second: Option<&str>,
    ) -> Result<Option<NodeRecord>, GraphError> {
        let mut query = sqlx::query_as::<_, NodeRow>(sql).bind(first);
        if let Some(second) = second {
            query = query.bind(second);
        }
        query
            .fetch_optional(&mut *self.connection)
            .await?
            .map(NodeRecord::try_from)
            .transpose()
    }
}

impl TryFrom<NodeRow> for NodeRecord {
    type Error = GraphError;

    fn try_from(row: NodeRow) -> Result<Self, Self::Error> {
        Ok(Self {
            node: GraphNode {
                id: valid_node_id(row.id)?,
                client_key: row.client_key,
                leased_action_id: row.leased_action_id.map(valid_action_id).transpose()?,
                kind: row.kind,
                icon: row.icon,
                title: row.title,
                detail: row.detail,
                authored_detail: row
                    .authored_detail
                    .map(|value| serde_json::from_str(&value))
                    .transpose()
                    .map_err(|error| {
                        GraphError::Internal(format!(
                            "stored authored Node Detail is invalid JSON: {error}"
                        ))
                    })?,
                state: RecordState::parse(&row.state)?,
            },
            owner: row.owner_interaction_id.map(valid_node_id).transpose()?,
        })
    }
}

fn draft_node(id: NodeId, draft: &NodeDraft, authored_detail: Option<&str>) -> GraphNode {
    GraphNode {
        id,
        client_key: Some(draft.client_key.clone()),
        leased_action_id: None,
        kind: draft.kind.clone(),
        icon: draft.icon.clone(),
        title: draft.title.clone(),
        detail: draft.detail.clone(),
        authored_detail: authored_detail
            .map(serde_json::from_str)
            .transpose()
            .expect("serialized authored detail must deserialize"),
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

fn valid_project_id(value: i64) -> Result<ProjectId, GraphError> {
    ProjectId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid project ID".into()))
}

fn valid_thread_id(value: i64) -> Result<ThreadId, GraphError> {
    ThreadId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid thread ID".into()))
}

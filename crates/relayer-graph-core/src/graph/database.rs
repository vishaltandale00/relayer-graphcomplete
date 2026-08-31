use std::path::Path;

use crate::{
    AcceptedGraphClosure, CompletionState, CurrentProjectionEvent, CurrentProjectionPage,
    CurrentTransitionReceipt, GraphError, GraphNode, GraphWriter, InteractionContextAction,
    InteractionContextDraft, InteractionContextTarget, InteractionInputNode, InteractionInvocation,
    NodeId, PERSONAL_PRESENTATION_PROFILE_THREAD_ID, ProjectId, TemporalFeatureConfig, ThreadId,
    graph::{InteractionScope, model::require_nonempty},
    interaction_input_digest,
    storage::{
        SqliteGraphStore,
        sqlite::{contexts::ContextTable, currents::CurrentTable, nodes::NodeTable},
    },
};

#[derive(Clone)]
pub struct GraphDatabase {
    pub(crate) storage: SqliteGraphStore,
}

impl GraphDatabase {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, GraphError> {
        Ok(Self {
            storage: SqliteGraphStore::open(path).await?,
        })
    }

    pub async fn in_memory() -> Result<Self, GraphError> {
        Ok(Self {
            storage: SqliteGraphStore::in_memory().await?,
        })
    }

    pub async fn temporal_features(&self) -> Result<TemporalFeatureConfig, GraphError> {
        let mut transaction = self.storage.begin_read().await?;
        let config = CurrentTable::new(&mut transaction)
            .temporal_features()
            .await?;
        transaction.commit().await?;
        Ok(config)
    }

    pub async fn set_temporal_features(
        &self,
        config: TemporalFeatureConfig,
    ) -> Result<(), GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        CurrentTable::new(&mut transaction)
            .set_temporal_features(config)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn create_interaction(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
    ) -> Result<GraphNode, GraphError> {
        self.create_interaction_with_invocation(project_id, thread_id, text, None)
            .await
    }

    pub async fn create_interaction_with_invocation(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        invocation: Option<InteractionInvocation>,
    ) -> Result<GraphNode, GraphError> {
        reject_reserved_profile_thread(thread_id)?;
        if invocation.is_none() {
            require_nonempty(text, "text")?;
        }
        let mut transaction = self.storage.begin_write().await?;
        let node = NodeTable::new(&mut transaction)
            .insert_interaction(project_id, thread_id, text, invocation)
            .await?;
        initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
        transaction.commit().await?;
        Ok(node)
    }

    pub async fn create_interaction_with_context(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        contexts: &[InteractionContextDraft],
    ) -> Result<(GraphNode, Vec<InteractionContextAction>), GraphError> {
        reject_reserved_profile_thread(thread_id)?;
        if text.trim().is_empty()
            && !contexts
                .iter()
                .flat_map(|context| &context.annotations)
                .any(|annotation| !annotation.trim().is_empty())
        {
            return Err(GraphError::validation(
                "missing_interaction_input",
                "text",
                "An interaction needs non-whitespace message text or at least one non-whitespace context annotation.",
            ));
        }
        let mut transaction = self.storage.begin_write().await?;
        let node = NodeTable::new(&mut transaction)
            .insert_interaction(project_id, thread_id, text, None)
            .await?;
        initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
        let scope = InteractionScope {
            project_id,
            thread_id,
            root_node_id: node.id,
            read_only: false,
            authority_epoch: None,
        };
        let actions = ContextTable::new(&mut transaction)
            .insert_all(&scope, contexts)
            .await?;
        transaction.commit().await?;
        Ok((node, actions))
    }

    pub async fn create_identified_interaction_with_context(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        input_identity: &str,
        input_digest: &str,
        contexts: &[InteractionContextDraft],
    ) -> Result<(GraphNode, Vec<InteractionContextAction>), GraphError> {
        reject_reserved_profile_thread(thread_id)?;
        self.create_identified_interaction_with_context_inner(
            project_id,
            thread_id,
            text,
            input_identity,
            input_digest,
            contexts,
        )
        .await
    }

    pub async fn create_personal_presentation_interaction(
        &self,
        text: &str,
        input_identity: &str,
        input_digest: &str,
    ) -> Result<GraphNode, GraphError> {
        if !input_identity.starts_with("relayer.personal-presentation:") {
            return Err(GraphError::validation(
                "invalid_personal_presentation_identity",
                "inputIdentity",
                "A personal-presentation interaction needs the reserved identity prefix.",
            ));
        }
        let thread_id = ThreadId::new(PERSONAL_PRESENTATION_PROFILE_THREAD_ID)
            .expect("the reserved profile thread identity is positive");
        let (node, actions) = self
            .create_identified_interaction_with_context_inner(
                None,
                thread_id,
                text,
                input_identity,
                input_digest,
                &[],
            )
            .await?;
        debug_assert!(actions.is_empty());
        Ok(node)
    }

    async fn create_identified_interaction_with_context_inner(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        input_identity: &str,
        input_digest: &str,
        contexts: &[InteractionContextDraft],
    ) -> Result<(GraphNode, Vec<InteractionContextAction>), GraphError> {
        require_nonempty(input_identity, "inputIdentity")?;
        require_nonempty(input_digest, "inputDigest")?;
        let computed_digest = interaction_input_digest(text, contexts).map_err(|error| {
            GraphError::Internal(format!("could not digest interaction input: {error}"))
        })?;
        if input_digest != computed_digest {
            return Err(GraphError::validation(
                "interaction_input_digest_mismatch",
                "inputDigest",
                "The supplied interaction input digest does not match the exact message and ordered context.",
            ));
        }
        let mut transaction = self.storage.begin_write().await?;
        if let Some(node) = NodeTable::new(&mut transaction)
            .identified_interaction(thread_id, input_identity, input_digest)
            .await?
        {
            initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
            let scope = InteractionScope {
                project_id,
                thread_id,
                root_node_id: node.id,
                read_only: false,
                authority_epoch: None,
            };
            let actions = ContextTable::new(&mut transaction).actions(&scope).await?;
            let persisted = actions
                .iter()
                .map(|action| InteractionContextDraft {
                    target: action.target.clone(),
                    annotations: action.annotations.clone(),
                })
                .collect::<Vec<_>>();
            let persisted_digest =
                interaction_input_digest(&node.detail, &persisted).map_err(|error| {
                    GraphError::Internal(format!(
                        "could not verify stored interaction input: {error}"
                    ))
                })?;
            if persisted_digest != input_digest {
                return Err(GraphError::Internal(
                    "stored interaction input does not match its durable digest".into(),
                ));
            }
            transaction.commit().await?;
            return Ok((node, actions));
        }
        if text.trim().is_empty()
            && !contexts
                .iter()
                .flat_map(|context| &context.annotations)
                .any(|annotation| !annotation.trim().is_empty())
        {
            return Err(GraphError::validation(
                "missing_interaction_input",
                "text",
                "An interaction needs non-whitespace message text or at least one non-whitespace context annotation.",
            ));
        }
        let node = NodeTable::new(&mut transaction)
            .insert_interaction(project_id, thread_id, text, None)
            .await?;
        initialize_completion(&mut transaction, &node, project_id, thread_id).await?;
        NodeTable::new(&mut transaction)
            .set_input_identity(node.id, input_identity, input_digest)
            .await?;
        let scope = InteractionScope {
            project_id,
            thread_id,
            root_node_id: node.id,
            read_only: false,
            authority_epoch: None,
        };
        let actions = ContextTable::new(&mut transaction)
            .insert_all(&scope, contexts)
            .await?;
        transaction.commit().await?;
        Ok((node, actions))
    }

    pub async fn writer_for_subgraph(&self, node_id: NodeId) -> Result<GraphWriter, GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        let scope = NodeTable::new(&mut transaction)
            .interaction_scope(node_id)
            .await?;
        initialize_completion_scope(&mut transaction, &scope).await?;
        transaction.commit().await?;
        Ok(GraphWriter::new(self.clone(), scope))
    }

    pub async fn writer_for_completion_authority(
        &self,
        node_id: NodeId,
        authority_epoch: u64,
    ) -> Result<GraphWriter, GraphError> {
        let mut scope = {
            let mut connection = self.storage.acquire().await?;
            NodeTable::new(&mut connection)
                .interaction_scope(node_id)
                .await?
        };
        scope.authority_epoch = Some(authority_epoch);
        Ok(GraphWriter::new(self.clone(), scope))
    }

    pub async fn activate_completion_authority(&self, node_id: NodeId) -> Result<u64, GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        NodeTable::new(&mut transaction)
            .interaction_scope(node_id)
            .await?;
        let epoch = CurrentTable::new(&mut transaction)
            .activate_authority(node_id)
            .await?;
        transaction.commit().await?;
        Ok(epoch)
    }

    pub async fn cutover_completion_authority(&self, node_id: NodeId) -> Result<(), GraphError> {
        let mut transaction = self.storage.begin_write().await?;
        CurrentTable::new(&mut transaction)
            .cutover_authority(node_id)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn accepted_graph_closure(
        &self,
        node_id: NodeId,
    ) -> Result<Option<AcceptedGraphClosure>, GraphError> {
        crate::graph::completion::read_accepted_closure(self, node_id).await
    }

    pub async fn current_completion(&self, node_id: NodeId) -> Result<CompletionState, GraphError> {
        self.writer_for_subgraph(node_id)
            .await?
            .current_completion()
            .await
    }

    pub async fn current_projection_events(
        &self,
        after_sequence: u64,
        limit: u32,
    ) -> Result<Vec<CurrentProjectionEvent>, GraphError> {
        crate::graph::completion::projections_after(self, after_sequence, limit).await
    }

    pub async fn current_projection_page(
        &self,
        completion_ids: &[NodeId],
        after_sequence: u64,
        limit: u32,
    ) -> Result<CurrentProjectionPage, GraphError> {
        crate::graph::completion::projection_page(self, completion_ids, after_sequence, limit).await
    }

    pub async fn current_transition_receipt(
        &self,
        node_id: NodeId,
        operation_key: &str,
    ) -> Result<Option<CurrentTransitionReceipt>, GraphError> {
        let mut transaction = self.storage.begin_read().await?;
        NodeTable::new(&mut transaction)
            .interaction_scope(node_id)
            .await?;
        let receipt = CurrentTable::new(&mut transaction)
            .receipt(node_id, operation_key)
            .await?;
        transaction.commit().await?;
        Ok(receipt)
    }

    pub async fn interaction_invocation(
        &self,
        node_id: NodeId,
    ) -> Result<Option<InteractionInvocation>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        Ok(NodeTable::new(&mut connection)
            .interaction_lease(node_id)
            .await?
            .map(|lease| InteractionInvocation {
                source_interaction_node_id: lease.source_interaction_id,
                source_action_id: lease.action_id,
            }))
    }

    pub async fn interaction_input_identity(
        &self,
        node_id: NodeId,
    ) -> Result<Option<(String, String)>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        NodeTable::new(&mut connection)
            .interaction_input_identity(node_id)
            .await
    }

    pub async fn interaction_context_actions(
        &self,
        node_id: NodeId,
    ) -> Result<Vec<InteractionContextAction>, GraphError> {
        let scope = {
            let mut connection = self.storage.acquire().await?;
            NodeTable::new(&mut connection)
                .interaction_scope(node_id)
                .await?
        };
        let mut connection = self.storage.acquire().await?;
        ContextTable::new(&mut connection).actions(&scope).await
    }

    pub async fn canonical_interaction_context_occurrence(
        &self,
        target: &InteractionContextTarget,
    ) -> Result<InteractionInputNode, GraphError> {
        let scope = {
            let mut connection = self.storage.acquire().await?;
            NodeTable::new(&mut connection)
                .interaction_scope(target.source_interaction_node_id)
                .await
                .map_err(|error| match error {
                    GraphError::Forbidden(_) | GraphError::NotFound(_) => GraphError::validation(
                        "invalid_context_occurrence",
                        "target",
                        "Context must identify an accepted node occurrence in the exact visible accepted source completion.",
                    ),
                    other => other,
                })?
        };
        let mut connection = self.storage.acquire().await?;
        ContextTable::new(&mut connection)
            .canonical_occurrence(&scope, "target", target)
            .await
    }

    pub async fn close(&self) {
        self.storage.close().await;
    }
}

pub(crate) async fn initialize_completion(
    connection: &mut crate::storage::GraphConnection,
    node: &GraphNode,
    project_id: Option<ProjectId>,
    thread_id: ThreadId,
) -> Result<(), GraphError> {
    let scope = InteractionScope {
        project_id,
        thread_id,
        root_node_id: node.id,
        read_only: false,
        authority_epoch: None,
    };
    initialize_completion_scope(connection, &scope).await
}

async fn initialize_completion_scope(
    connection: &mut crate::storage::GraphConnection,
    scope: &InteractionScope,
) -> Result<(), GraphError> {
    let (entitlement, digest) = scope.read_entitlement();
    CurrentTable::new(connection)
        .initialize(scope.root_node_id, !scope.read_only, &entitlement, &digest)
        .await
}

fn reject_reserved_profile_thread(thread_id: ThreadId) -> Result<(), GraphError> {
    if thread_id.value() == PERSONAL_PRESENTATION_PROFILE_THREAD_ID {
        return Err(GraphError::validation(
            "reserved_personal_presentation_thread",
            "threadId",
            "The personal-presentation profile thread is reserved for its dedicated control boundary.",
        ));
    }
    Ok(())
}

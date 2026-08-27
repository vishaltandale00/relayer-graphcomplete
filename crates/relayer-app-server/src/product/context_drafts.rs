use super::{NodeContextDraftConfirmation, ProductError, ProductService, ThreadId};
use crate::runtime::RuntimeClient;
use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum NodeContextDraftConfirmationError {
    #[error(transparent)]
    Product(#[from] ProductError),
    #[error("the saved node occurrence is no longer available")]
    TargetUnavailable,
}

#[derive(Clone)]
pub(crate) struct NodeContextDraftConfirmationService {
    product: ProductService,
    runtime: Option<RuntimeClient>,
}

impl NodeContextDraftConfirmationService {
    pub(crate) fn new(product: ProductService, runtime: Option<RuntimeClient>) -> Self {
        Self { product, runtime }
    }

    pub(crate) async fn confirm(
        &self,
        thread_id: ThreadId,
        draft_id: &str,
        expected_revision: i64,
    ) -> Result<NodeContextDraftConfirmation, NodeContextDraftConfirmationError> {
        if let Some(confirmation) = self
            .product
            .node_context_draft_confirmation(thread_id, draft_id, expected_revision)
            .await?
        {
            return Ok(confirmation);
        }
        let runtime = self
            .runtime
            .as_ref()
            .ok_or(NodeContextDraftConfirmationError::TargetUnavailable)?;
        let draft = match self.product.node_context_draft(thread_id, draft_id).await {
            Ok(draft) => draft,
            Err(ProductError::NotFound(_)) => {
                return Err(NodeContextDraftConfirmationError::TargetUnavailable);
            }
            Err(error) => return Err(error.into()),
        };
        if draft.text.trim().is_empty() {
            return Err(ProductError::Invalid(
                "An annotation is required before this draft can be confirmed.".into(),
            )
            .into());
        }
        let source = self
            .product
            .get_interaction_by_graph_node_id(draft.target.source_interaction_node_id)
            .await
            .map_err(|_| NodeContextDraftConfirmationError::TargetUnavailable)?;
        if source.thread_id != thread_id || source.completion_status != "accepted" {
            return Err(NodeContextDraftConfirmationError::TargetUnavailable);
        }
        let current_target = runtime
            .canonical_interaction_context_occurrence(
                &relayer_graph_core::InteractionContextTarget {
                    node_id: relayer_graph_core::NodeId::new(draft.target.node_id)
                        .ok_or(NodeContextDraftConfirmationError::TargetUnavailable)?,
                    source_interaction_node_id: relayer_graph_core::NodeId::new(
                        draft.target.source_interaction_node_id,
                    )
                    .ok_or(NodeContextDraftConfirmationError::TargetUnavailable)?,
                    source_layer_id: relayer_graph_core::LayerId::new(draft.target.source_layer_id)
                        .ok_or(NodeContextDraftConfirmationError::TargetUnavailable)?,
                },
            )
            .await
            .map_err(|_| NodeContextDraftConfirmationError::TargetUnavailable)?;
        if current_target != draft.target_node {
            return Err(NodeContextDraftConfirmationError::TargetUnavailable);
        }
        self.product
            .confirm_node_context_draft(thread_id, draft_id, expected_revision)
            .await
            .map_err(Into::into)
    }
}

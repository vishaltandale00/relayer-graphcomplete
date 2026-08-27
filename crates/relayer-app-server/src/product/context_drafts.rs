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
    runtime: RuntimeClient,
}

impl NodeContextDraftConfirmationService {
    pub(crate) fn new(product: ProductService, runtime: RuntimeClient) -> Self {
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
        let draft = self.product.node_context_draft(thread_id, draft_id).await?;
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
        let layer: relayer_graph_core::ResolvedLayer = self
            .runtime
            .get_layer(
                draft.target.source_interaction_node_id,
                draft.target.source_layer_id,
            )
            .await
            .map_err(|_| NodeContextDraftConfirmationError::TargetUnavailable)
            .and_then(|value| {
                serde_json::from_value(value)
                    .map_err(|_| NodeContextDraftConfirmationError::TargetUnavailable)
            })?;
        let current_target = layer
            .nodes
            .into_iter()
            .find(|node| {
                node.id.value() == draft.target.node_id
                    && node.state == relayer_graph_core::RecordState::Accepted
            })
            .map(relayer_graph_core::InteractionInputNode::from);
        if layer.layer.id.value() != draft.target.source_layer_id
            || layer.layer.state != relayer_graph_core::RecordState::Accepted
            || current_target.as_ref() != Some(&draft.target_node)
        {
            return Err(NodeContextDraftConfirmationError::TargetUnavailable);
        }
        self.product
            .confirm_node_context_draft(thread_id, draft_id, expected_revision)
            .await
            .map_err(Into::into)
    }
}

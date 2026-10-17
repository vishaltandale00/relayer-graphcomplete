//! Bounded thread discovery and inert historical input, under the caller's authority.
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::storage::sqlite::{contexts::ContextTable, nodes::NodeTable};
use crate::{
    CompletionLifecycle, GraphError, GraphWriter, InputAction, InteractionInput, LayerId,
    LiveAnswer, NodeId, PresentingInputOccurrence, ProjectId, SubmittedInputValue,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionHistoryEntry {
    pub interaction_node_id: NodeId,
    pub lifecycle: Option<CompletionLifecycle>,
    pub current_layer_id: Option<LayerId>,
    pub returned_layer_id: Option<LayerId>,
    pub parent_node_id: Option<NodeId>,
    pub source_completion_id: Option<NodeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionHistoryPage {
    pub entries: Vec<CompletionHistoryEntry>,
    pub next_before_node_id: Option<NodeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalAnswer {
    pub sequence: i64,
    pub occurrence: PresentingInputOccurrence,
    pub question: InputAction,
    pub value: SubmittedInputValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalInteractionInput {
    pub input: InteractionInput,
    pub live_answers: Vec<HistoricalAnswer>,
    pub next_answer_sequence: Option<i64>,
}

// Preparation may seal a child before its callable is published. Only its owning
// parent may inspect that private call; other completions wait for publication.
// A typed legacy lease may convert the shared action. Its immutable receipt
// preserves the published instruction, including calls from reused occurrences.
const VISIBLE_ORIGIN: &str = r#"
(n.id=?2 OR NOT EXISTS(
    SELECT 1 FROM durable_invocations private_call
    JOIN actions private_action ON private_action.id=private_call.source_action_id
    JOIN nodes private_parent ON private_parent.id=private_call.parent_node_id
    WHERE private_call.child_interaction_node_id=n.id AND private_call.source_completion_id!=?2
      AND NOT (private_action.state='accepted' AND private_parent.state='accepted'
        AND json_extract(private_call.action_snapshot,'$.sourceLayerId') IS private_action.source_layer_id
        AND json_extract(private_call.action_snapshot,'$.sourceNodeId') IS private_action.source_node_id
        AND (json_extract(private_call.action_snapshot,'$.instruction') IS private_action.interaction_text
          OR (private_action.kind='navigate' AND private_action.relation='expand' AND private_action.interaction_text IS NULL
            AND EXISTS(SELECT 1 FROM invoke_resolution_transitions resolved
              JOIN nodes leased_result ON leased_result.id=resolved.interaction_node_id
              WHERE resolved.action_id=private_action.id AND resolved.target_layer_id=private_action.target_layer_id
                AND leased_result.leased_action_id=private_action.id
                AND json_extract(private_call.action_snapshot,'$.instruction') IS leased_result.detail)))
        AND json_extract(private_call.action_snapshot,'$.label') IS private_action.label
        AND json_extract(private_call.action_snapshot,'$.icon') IS private_action.icon
        AND json_extract(private_call.action_snapshot,'$.description') IS private_action.description
        AND json_extract(private_call.action_snapshot,'$.variant') IS private_action.variant
        AND json_extract(private_call.action_snapshot,'$.reusable') IS private_action.reusable
        AND COALESCE(json_extract(private_call.action_snapshot,'$.inputActionIds'),'[]') =
            (SELECT json_group_array(input_action_id) FROM (SELECT input_action_id FROM invoke_input_bindings WHERE invoke_action_id=private_action.id ORDER BY position))
        AND (private_action.source_layer_id IS NULL OR EXISTS(
            SELECT 1 FROM layers published_layer
            JOIN layer_nodes member ON member.layer_id=published_layer.id AND member.node_id=private_parent.id
            JOIN layer_actions occurrence ON occurrence.layer_id=published_layer.id AND occurrence.action_id=private_action.id
            WHERE published_layer.id=private_action.source_layer_id AND published_layer.state='accepted'
        )))
))"#;

impl GraphWriter {
    /// Discovery includes active, stopped and failed work, independently of search availability.
    pub async fn completion_history(
        &self,
        before: Option<NodeId>,
        limit: usize,
    ) -> Result<CompletionHistoryPage, GraphError> {
        if !(1..=50).contains(&limit) {
            return Err(GraphError::validation(
                "invalid_history_limit",
                "limit",
                "Use a history limit from 1 through 50.",
            ));
        }
        let mut transaction = self.database.storage.begin_read().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        if let Some(before) = before {
            require_thread_interaction(
                &mut transaction,
                self.scope.thread_id.value(),
                self.scope.project_id.map(ProjectId::value),
                self.scope.root_node_id,
                before,
            )
            .await?;
        }
        let mut rows = sqlx::query(&format!("SELECT n.id,s.lifecycle,s.current_layer_id,COALESCE(s.final_layer_id,a.target_layer_id) AS returned_layer_id,v.parent_node_id,COALESCE(v.source_completion_id,n.lease_source_interaction_id) AS source_completion_id FROM nodes n LEFT JOIN completion_states s ON s.interaction_node_id=n.id LEFT JOIN completions c ON c.interaction_node_id=n.id LEFT JOIN actions a ON a.id=c.root_action_id LEFT JOIN durable_invocations v ON v.child_interaction_node_id=n.id WHERE n.thread_id=?1 AND n.project_id IS ?5 AND n.kind='user-interaction' AND n.state='accepted' AND n.owner_interaction_id IS NULL AND n.id!=?2 AND (?3 IS NULL OR n.id<?3) AND {VISIBLE_ORIGIN} ORDER BY n.id DESC LIMIT ?4"))
            .bind(self.scope.thread_id.value()).bind(self.scope.root_node_id.value()).bind(before.map(NodeId::value)).bind((limit + 1) as i64).bind(self.scope.project_id.map(ProjectId::value))
            .fetch_all(&mut *transaction).await?;
        let more = rows.len() > limit;
        rows.truncate(limit);
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            let node = |value: Option<i64>| {
                value
                    .map(|id| {
                        NodeId::new(id)
                            .ok_or_else(|| GraphError::Internal("invalid history node".into()))
                    })
                    .transpose()
            };
            let layer = |value: Option<i64>| {
                value
                    .map(|id| {
                        LayerId::new(id)
                            .ok_or_else(|| GraphError::Internal("invalid history layer".into()))
                    })
                    .transpose()
            };
            entries.push(CompletionHistoryEntry {
                interaction_node_id: node(Some(row.try_get("id")?))?.unwrap(),
                lifecycle: row
                    .try_get::<Option<String>, _>("lifecycle")?
                    .map(|s| CompletionLifecycle::parse(&s))
                    .transpose()?,
                current_layer_id: layer(row.try_get("current_layer_id")?)?,
                returned_layer_id: layer(row.try_get("returned_layer_id")?)?,
                parent_node_id: node(row.try_get("parent_node_id")?)?,
                source_completion_id: node(row.try_get("source_completion_id")?)?,
            });
        }
        let next_before_node_id = more.then(|| entries.last().unwrap().interaction_node_id);
        transaction.commit().await?;
        Ok(CompletionHistoryPage {
            entries,
            next_before_node_id,
        })
    }

    /// The target's contract is historical data: it never becomes this caller's authority.
    pub async fn historical_interaction_input(
        &self,
        target: NodeId,
        after_answer_sequence: i64,
    ) -> Result<HistoricalInteractionInput, GraphError> {
        if after_answer_sequence < 0 {
            return Err(GraphError::validation(
                "invalid_history_cursor",
                "afterAnswerSequence",
                "Use a nonnegative answer cursor.",
            ));
        }
        let mut transaction = self.database.storage.begin_read().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        require_thread_interaction(
            &mut transaction,
            self.scope.thread_id.value(),
            self.scope.project_id.map(ProjectId::value),
            self.scope.root_node_id,
            target,
        )
        .await?;
        NodeTable::new(&mut transaction)
            .visible(&self.scope, target)
            .await?;
        let target_scope = super::InteractionScope {
            root_node_id: target,
            authority_epoch: None,
            read_only: true,
            ..self.scope
        };
        let input = ContextTable::new(&mut transaction)
            .interaction_input(&target_scope)
            .await?;
        let mut records: Vec<String> = sqlx::query_scalar("SELECT receipt_json FROM live_answers WHERE completion_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 51")
            .bind(target.value()).bind(after_answer_sequence).fetch_all(&mut *transaction).await?;
        let more = records.len() > 50;
        records.truncate(50);
        let live_answers = records
            .into_iter()
            .map(|record| {
                let answer: LiveAnswer = serde_json::from_str(&record)
                    .map_err(|_| GraphError::Internal("invalid historical answer".into()))?;
                Ok(HistoricalAnswer {
                    sequence: answer.sequence,
                    occurrence: answer.occurrence,
                    question: answer.question,
                    value: answer.value,
                })
            })
            .collect::<Result<Vec<_>, GraphError>>()?;
        let next_answer_sequence = more.then(|| live_answers.last().unwrap().sequence);
        transaction.commit().await?;
        Ok(HistoricalInteractionInput {
            input,
            live_answers,
            next_answer_sequence,
        })
    }
}

async fn require_thread_interaction(
    connection: &mut crate::storage::GraphConnection,
    thread_id: i64,
    project_id: Option<i64>,
    caller: NodeId,
    target: NodeId,
) -> Result<(), GraphError> {
    let valid: bool = sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM nodes n WHERE n.id=?1 AND n.thread_id=?3 AND n.project_id IS ?4 AND n.kind='user-interaction' AND n.state='accepted' AND n.owner_interaction_id IS NULL AND {VISIBLE_ORIGIN})"))
        .bind(target.value()).bind(caller.value()).bind(thread_id).bind(project_id).fetch_one(connection).await?;
    if !valid {
        return Err(GraphError::NotFound(format!("thread interaction {target}")));
    }
    Ok(())
}

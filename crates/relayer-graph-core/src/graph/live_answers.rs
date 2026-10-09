//! Supplemental accepted input is separate from the sealed initial contract.
use serde::{Deserialize, Serialize};

use super::InteractionScope;
use crate::storage::{
    GraphConnection,
    sqlite::{
        actions::ActionTable, currents::CurrentTable, input_children::validate_value,
        nodes::NodeTable,
    },
};
use crate::{
    ActionId, CompletionLifecycle, CompletionState, GraphDatabase, GraphError, InputAction,
    LayerId, NodeId, PresentingInputOccurrence, SubmittedInputValue, ThreadId,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveAnswerRequest {
    pub attempt_id: i64,
    pub authority_epoch: u64,
    pub expected_revision: u64,
    pub operation_key: String,
    pub occurrence: PresentingInputOccurrence,
    pub value: SubmittedInputValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAnswer {
    pub sequence: i64,
    pub completion_id: NodeId,
    pub attempt_id: i64,
    pub authority_epoch: u64,
    pub current_revision: u64,
    pub operation_key: String,
    pub occurrence: PresentingInputOccurrence,
    pub question: InputAction,
    pub value: SubmittedInputValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAnswerPage {
    pub current: CompletionState,
    pub authority_epoch: u64,
    pub answers: Vec<LiveAnswer>,
    pub current_answers: Vec<LiveAnswer>,
    pub next_sequence: i64,
    pub eligible_action_ids: Vec<ActionId>,
}

fn refused(code: &'static str, message: &str) -> GraphError {
    GraphError::validation(code, "liveAnswer", message)
}

fn encode<T: Serialize>(value: &T) -> Result<String, GraphError> {
    serde_json::to_string(value)
        .map_err(|_| GraphError::Internal("invalid live answer record".into()))
}

fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, GraphError> {
    serde_json::from_str(value)
        .map_err(|_| GraphError::Internal("invalid live answer record".into()))
}

async fn require_human_root(
    connection: &mut GraphConnection,
    scope: &InteractionScope,
) -> Result<(), GraphError> {
    let child: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM durable_invocations WHERE child_interaction_node_id=?1) OR EXISTS(SELECT 1 FROM nodes WHERE id=?1 AND leased_action_id IS NOT NULL)")
        .bind(scope.root_node_id.value()).fetch_one(&mut *connection).await?;
    if scope.read_only || child {
        return Err(refused(
            "live_answer_root_only",
            "Live answers require an original human completion.",
        ));
    }
    Ok(())
}

async fn epoch(connection: &mut GraphConnection, root: NodeId) -> Result<u64, GraphError> {
    let value: i64 = sqlx::query_scalar("SELECT authority_epoch FROM completion_authorities WHERE interaction_node_id=?1 AND author_eligible=1")
        .bind(root.value()).fetch_one(&mut *connection).await?;
    u64::try_from(value).map_err(|_| GraphError::Internal("invalid authority epoch".into()))
}

async fn eligible(
    connection: &mut GraphConnection,
    scope: &InteractionScope,
    state: &CompletionState,
) -> Result<Vec<ActionId>, GraphError> {
    if state.lifecycle != CompletionLifecycle::Active {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT a.id FROM layer_actions la JOIN actions a ON a.id=la.action_id
         JOIN layer_nodes ln ON ln.layer_id=la.layer_id AND ln.node_id=a.source_node_id
         JOIN layers l ON l.id=la.layer_id
         WHERE la.layer_id=?1 AND l.state='accepted' AND l.owner_interaction_id=?2
           AND a.state='accepted' AND a.kind='input' AND a.owner_interaction_id=?2
           AND NOT EXISTS(SELECT 1 FROM invoke_input_bindings b WHERE b.input_action_id=a.id)
           AND NOT EXISTS(SELECT 1 FROM live_answers answer WHERE answer.completion_id=?2
               AND answer.presenting_layer_id=la.layer_id AND answer.action_id=a.id) ORDER BY a.id",
    )
    .bind(state.current_layer_id.map(|id| id.value()))
    .bind(scope.root_node_id.value())
    .fetch_all(&mut *connection)
    .await?;
    ids.into_iter()
        .map(|id| {
            ActionId::new(id).ok_or_else(|| GraphError::Internal("invalid action identity".into()))
        })
        .collect()
}

pub(crate) async fn page(
    database: &GraphDatabase,
    scope: &InteractionScope,
    after: i64,
) -> Result<LiveAnswerPage, GraphError> {
    if after < 0 {
        return Err(refused(
            "invalid_live_answer_cursor",
            "Use a nonnegative answer cursor.",
        ));
    }
    let mut transaction = database.storage.begin_read().await?;
    scope.require_generation_authority(&mut transaction).await?;
    require_human_root(&mut transaction, scope).await?;
    let current = CurrentTable::new(&mut transaction)
        .state(scope.root_node_id)
        .await?;
    let authority_epoch = epoch(&mut transaction, scope.root_node_id).await?;
    let records: Vec<String> = sqlx::query_scalar("SELECT receipt_json FROM live_answers WHERE completion_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 100")
        .bind(scope.root_node_id.value()).bind(after).fetch_all(&mut *transaction).await?;
    let answers: Vec<LiveAnswer> = records
        .into_iter()
        .map(|record| decode(&record))
        .collect::<Result<_, GraphError>>()?;
    let next_sequence = answers.last().map_or(after, |answer| answer.sequence);
    let current_records: Vec<String> = sqlx::query_scalar("SELECT receipt_json FROM live_answers WHERE completion_id=?1 AND presenting_layer_id=?2 ORDER BY sequence")
        .bind(scope.root_node_id.value()).bind(current.current_layer_id.map(|id| id.value())).fetch_all(&mut *transaction).await?;
    let current_answers = current_records
        .into_iter()
        .map(|record| decode(&record))
        .collect::<Result<_, GraphError>>()?;
    let eligible_action_ids = eligible(&mut transaction, scope, &current).await?;
    transaction.commit().await?;
    Ok(LiveAnswerPage {
        current,
        authority_epoch,
        answers,
        current_answers,
        next_sequence,
        eligible_action_ids,
    })
}

pub(crate) async fn receipts(
    database: &GraphDatabase,
    scope: &InteractionScope,
    layer: LayerId,
) -> Result<Vec<LiveAnswer>, GraphError> {
    let mut transaction = database.storage.begin_read().await?;
    scope.require_generation_authority(&mut transaction).await?;
    require_human_root(&mut transaction, scope).await?;
    let records: Vec<String> = sqlx::query_scalar("SELECT receipt_json FROM live_answers WHERE completion_id=?1 AND presenting_layer_id=?2 ORDER BY sequence")
        .bind(scope.root_node_id.value()).bind(layer.value()).fetch_all(&mut *transaction).await?;
    let answers = records
        .into_iter()
        .map(|record| decode(&record))
        .collect::<Result<_, GraphError>>()?;
    transaction.commit().await?;
    Ok(answers)
}

impl GraphDatabase {
    /// Trusted Product admission. No provider or model capability can send input.
    pub async fn accept_live_answer(
        &self,
        completion: NodeId,
        thread: ThreadId,
        request: &LiveAnswerRequest,
    ) -> Result<LiveAnswer, GraphError> {
        if request.attempt_id <= 0
            || request.operation_key.is_empty()
            || request.operation_key.len() > 80
            || !request
                .operation_key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(refused(
                "invalid_live_answer_identity",
                "Use a positive attempt and stable answer identity.",
            ));
        }
        let mut transaction = self.storage.begin_write().await?;
        let scope = NodeTable::new(&mut transaction)
            .interaction_scope(completion)
            .await?;
        if scope.thread_id != thread
            || request.occurrence.presenting_interaction_node_id != completion
        {
            return Err(refused(
                "live_answer_scope",
                "Answer the exact completion in this thread.",
            ));
        }
        require_human_root(&mut transaction, &scope).await?;
        let request_json = encode(request)?;
        let prior: Option<(String, String)> = sqlx::query_as("SELECT request_json,receipt_json FROM live_answers WHERE completion_id=?1 AND operation_key=?2")
            .bind(completion.value()).bind(&request.operation_key).fetch_optional(&mut *transaction).await?;
        if let Some((original, receipt)) = prior {
            if original != request_json {
                return Err(refused(
                    "live_answer_conflict",
                    "This answer identity already contains different input.",
                ));
            }
            let answer = decode(&receipt)?;
            transaction.commit().await?;
            return Ok(answer);
        }
        let current = CurrentTable::new(&mut transaction)
            .state(completion)
            .await?;
        if current.lifecycle != CompletionLifecycle::Active {
            return Err(refused(
                "terminal_completion",
                "This completion has settled. Send a new interaction instead.",
            ));
        }
        if current.head_revision != request.expected_revision
            || current.current_layer_id != Some(request.occurrence.presenting_layer_id)
            || epoch(&mut transaction, completion).await? != request.authority_epoch
        {
            return Err(refused(
                "stale_live_question",
                "Reopen the current question before answering.",
            ));
        }
        if !eligible(&mut transaction, &scope, &current)
            .await?
            .contains(&request.occurrence.action_id)
        {
            return Err(refused(
                "live_question_unavailable",
                "This question is unavailable or already answered.",
            ));
        }
        let action = ActionTable::new(&mut transaction)
            .record(&scope, request.occurrence.action_id)
            .await?
            .ok_or_else(|| {
                refused(
                    "live_question_unavailable",
                    "The published question is unavailable.",
                )
            })?
            .action;
        let question = action.input.ok_or_else(|| {
            refused(
                "live_question_unavailable",
                "The action must be an Input question.",
            )
        })?;
        let value = validate_value(0, &question, &request.value)?;
        let sequence: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0)+1 FROM live_answers")
                .fetch_one(&mut *transaction)
                .await?;
        let answer = LiveAnswer {
            sequence,
            completion_id: completion,
            attempt_id: request.attempt_id,
            authority_epoch: request.authority_epoch,
            current_revision: request.expected_revision,
            operation_key: request.operation_key.clone(),
            occurrence: request.occurrence.clone(),
            question,
            value,
        };
        sqlx::query("INSERT INTO live_answers(sequence,completion_id,attempt_id,authority_epoch,current_revision,presenting_layer_id,action_id,operation_key,request_json,receipt_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")
            .bind(sequence).bind(completion.value()).bind(request.attempt_id).bind(i64::try_from(request.authority_epoch).map_err(|_| refused("invalid_live_answer_identity", "Invalid authority epoch."))?)
            .bind(i64::try_from(request.expected_revision).map_err(|_| refused("invalid_live_answer_identity", "Invalid current revision."))?)
            .bind(request.occurrence.presenting_layer_id.value()).bind(request.occurrence.action_id.value())
            .bind(&request.operation_key).bind(request_json).bind(encode(&answer)?).execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(answer)
    }
}

ALTER TABLE action_invocations ADD COLUMN presenting_layer_id INTEGER CHECK(presenting_layer_id IS NULL OR presenting_layer_id>0);

-- A refused handoff before graph binding preserves the captured answers. Binding
-- and consumption are atomic; this refusal restoration is atomic with its status.
CREATE TRIGGER invocation_preexecution_inputs_restore
AFTER UPDATE OF completion_status ON interactions
WHEN OLD.completion_status != NEW.completion_status
 AND NEW.completion_status IN ('failed','stopped','not_started') AND NEW.graph_node_id IS NULL
 AND EXISTS(SELECT 1 FROM invocation_input_submission_receipts r JOIN action_invocations ai ON ai.result_interaction_id=r.result_interaction_id WHERE r.result_interaction_id=NEW.id AND ai.prepared_graph_node_id IS NOT NULL AND ai.authoritative=1 AND ai.agent_invoked=0 AND json_array_length(r.attachments_json)>0)
BEGIN
 INSERT INTO action_input_attachments(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_json,value_json,committed_at)
 SELECT NEW.thread_id,json_extract(input.value,'$.occurrence.presentingInteractionNodeId'),json_extract(input.value,'$.occurrence.presentingLayerId'),json_extract(input.value,'$.occurrence.actionId'),json_extract(input.value,'$.source_node_id'),json_extract(input.value,'$.action'),json_extract(input.value,'$.value'),json_extract(input.value,'$.committed_at')
 FROM invocation_input_submission_receipts r,json_each(r.attachments_json) input
 WHERE r.result_interaction_id=NEW.id
 ON CONFLICT(thread_id,presenting_interaction_node_id,presenting_layer_id,action_id) DO NOTHING;
 UPDATE action_input_drafts SET revision=revision+1 WHERE thread_id=NEW.thread_id AND changes()>0;
END;

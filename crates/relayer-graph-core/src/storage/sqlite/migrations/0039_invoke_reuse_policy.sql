-- NULL preserves historical implied reuse; new native authoring writes 0 or 1.
ALTER TABLE actions ADD COLUMN reusable INTEGER CHECK(reusable IS NULL OR reusable IN (0,1));
CREATE TRIGGER accepted_invoke_reuse_immutable BEFORE UPDATE OF reusable ON actions
WHEN OLD.state <> 'draft' AND NEW.reusable IS NOT OLD.reusable
BEGIN SELECT RAISE(ABORT, 'accepted invoke reuse policy is immutable'); END;
CREATE TRIGGER durable_invocations_single_call BEFORE INSERT ON durable_invocations
WHEN (SELECT reusable FROM actions WHERE id=NEW.source_action_id)=0
 AND EXISTS(SELECT 1 FROM durable_invocations WHERE source_action_id=NEW.source_action_id)
BEGIN SELECT RAISE(ABORT, 'single-call Invoke already has an Invocation'); END;

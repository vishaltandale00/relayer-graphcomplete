CREATE TABLE invocation_input_submission_receipts (
    result_interaction_id INTEGER PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
    input_draft_revision INTEGER,
    attachments_json TEXT NOT NULL CHECK(json_valid(attachments_json))
);
CREATE TRIGGER invocation_input_submission_receipts_immutable
BEFORE UPDATE ON invocation_input_submission_receipts
BEGIN SELECT RAISE(ABORT, 'invocation input submission receipts are immutable'); END;

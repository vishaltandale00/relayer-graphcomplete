-- Historical attempts have no attested epoch/attempt pair and remain ineligible.
ALTER TABLE interaction_attempts ADD COLUMN live_answer_authority_epoch INTEGER
    CHECK (live_answer_authority_epoch IS NULL OR live_answer_authority_epoch > 0);
CREATE TRIGGER immutable_attempt_live_answer_authority
BEFORE UPDATE OF live_answer_authority_epoch ON interaction_attempts
BEGIN
    SELECT RAISE(ABORT, 'attempt live-answer authority is immutable');
END;

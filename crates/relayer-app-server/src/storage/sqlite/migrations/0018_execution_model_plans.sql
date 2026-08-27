ALTER TABLE interaction_attempts ADD COLUMN attempt_admission_id TEXT;
ALTER TABLE interaction_attempts ADD COLUMN admitted_plan_json TEXT;
ALTER TABLE interaction_attempts ADD COLUMN admitted_plan_digest TEXT;

CREATE UNIQUE INDEX interaction_attempts_admission_id
ON interaction_attempts(attempt_admission_id)
WHERE attempt_admission_id IS NOT NULL;

CREATE TRIGGER interaction_attempt_plan_pair_insert
BEFORE INSERT ON interaction_attempts
WHEN (NEW.attempt_admission_id IS NULL) != (NEW.admitted_plan_json IS NULL)
  OR (NEW.admitted_plan_json IS NULL) != (NEW.admitted_plan_digest IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'interaction attempt admission plan fields must be all null or all present');
END;

CREATE TRIGGER interaction_attempt_plan_pair_update
BEFORE UPDATE OF attempt_admission_id,admitted_plan_json,admitted_plan_digest ON interaction_attempts
WHEN (NEW.attempt_admission_id IS NULL) != (NEW.admitted_plan_json IS NULL)
  OR (NEW.admitted_plan_json IS NULL) != (NEW.admitted_plan_digest IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'interaction attempt admission plan fields must be all null or all present');
END;

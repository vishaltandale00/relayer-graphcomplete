-- Existing and imported conversations keep their original native continuity policy.
ALTER TABLE threads ADD COLUMN continuation_mode TEXT NOT NULL DEFAULT 'native'
    CHECK(continuation_mode IN ('native','graph-v1'));
CREATE TRIGGER immutable_thread_continuation_mode
BEFORE UPDATE OF continuation_mode ON threads
WHEN OLD.continuation_mode != NEW.continuation_mode
BEGIN
    SELECT RAISE(ABORT, 'thread continuation mode is immutable');
END;

-- #584 / ADR 0014: each thread records how its conversation continues. Every existing
-- thread is legacy, whose earlier turns exist for the agent only in a native session.
-- A continuation-v1 conversation reads earlier turns from the graph. Only ordinary,
-- non-imported conversations can have that format, and it is fixed at creation.
-- Any later rebuild of the threads table must keep both this CHECK and the trigger below;
-- schema.rs refuses to open a database missing either.
ALTER TABLE threads ADD COLUMN conversation_format TEXT NOT NULL DEFAULT 'legacy'
    CHECK (
        conversation_format = 'legacy'
        OR (
            conversation_format = 'continuation-v1'
            AND surface = 'conversation'
            AND conversation_import_id IS NULL
        )
    );

CREATE TRIGGER thread_conversation_format_immutable
BEFORE UPDATE OF conversation_format ON threads
WHEN OLD.conversation_format IS NOT NEW.conversation_format
BEGIN
    SELECT RAISE(ABORT, 'conversation_format_immutable');
END;

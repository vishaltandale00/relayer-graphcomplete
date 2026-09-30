-- #584 / ADR 0014 / PRD CONT-013: the bounded action ledger of one settled attempt, as the
-- harness adapter recorded it from its own native events. It holds at most 64 short, redacted
-- summaries (kind, status, optional exit code) plus a count of omitted actions. It never holds
-- tool output, transcripts, or secrets. Only a continuation-v1 conversation keeps one; a
-- legacy conversation's earlier turns are not readable through the graph. It is written once,
-- when the harness host reports the attempt's settlement, and never changes. A crash before
-- that report leaves no ledger: effect_boundary='unknown' remains the only signal.
CREATE TABLE interaction_attempt_actions (
    attempt_id INTEGER PRIMARY KEY REFERENCES interaction_attempts(id) ON DELETE CASCADE,
    entries_json TEXT NOT NULL CHECK (
        json_valid(entries_json)
        AND json_type(entries_json) = 'array'
        AND json_array_length(entries_json) <= 64
    ),
    omitted INTEGER NOT NULL CHECK (omitted >= 0),
    recorded_at TEXT NOT NULL
);

CREATE TRIGGER interaction_attempt_actions_require_continuation
BEFORE INSERT ON interaction_attempt_actions
WHEN NOT EXISTS (
    SELECT 1
    FROM interaction_attempts a
    JOIN interactions i ON i.id = a.interaction_id
    JOIN threads t ON t.id = i.thread_id
    WHERE a.id = NEW.attempt_id AND t.conversation_format = 'continuation-v1'
)
BEGIN
    SELECT RAISE(ABORT, 'attempt_actions_require_continuation');
END;

CREATE TRIGGER interaction_attempt_actions_immutable
BEFORE UPDATE ON interaction_attempt_actions
BEGIN
    SELECT RAISE(ABORT, 'attempt_actions_immutable');
END;

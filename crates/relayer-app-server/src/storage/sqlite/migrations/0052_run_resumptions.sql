-- A run the user resumed after a restart (#722). Resume is repeatable: a later Resume of the
-- same run reports it as it stands, even once it has ended, and starts nothing. A run that was
-- never paused or interrupted has no row here, so its Resume is refused.
CREATE TABLE run_resumptions (
    interaction_id INTEGER PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
    resumed_at TEXT NOT NULL
);

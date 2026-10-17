-- A run the user resumed after a restart (#722). Resume is repeatable: a later Resume of the
-- same run reports it as it stands, even once it has ended, and starts nothing. A run that was
-- never paused or interrupted has no row here, so its Resume is refused.
CREATE TABLE run_resumptions (
    interaction_id INTEGER PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
    resumed_at TEXT NOT NULL
);

-- A run the user discarded after a restart (#722), recorded with the Discard itself. A repeated
-- Discard reports the run as it stands, while its graph Stop settles and after, and starts
-- nothing; any other run's Discard is refused.
CREATE TABLE run_discards (
    interaction_id INTEGER PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
    discarded_at TEXT NOT NULL
);

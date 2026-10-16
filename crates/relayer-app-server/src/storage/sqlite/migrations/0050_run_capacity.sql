-- The app executes at most a fixed number of human-started runs at once (#720). Above that
-- limit a run waits as `queued`, and this row records that it waits for capacity rather than
-- behind a run on its node. A run waits here only after its start was claimed, so it returns
-- to `submitted` when a slot frees. A child an agent invoked never waits here.
CREATE TABLE run_capacity_waits (
    interaction_id INTEGER PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE
);

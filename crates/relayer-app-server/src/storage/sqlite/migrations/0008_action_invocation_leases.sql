ALTER TABLE action_invocations
ADD COLUMN graph_lease_required INTEGER NOT NULL DEFAULT 0
CHECK (graph_lease_required IN (0, 1));

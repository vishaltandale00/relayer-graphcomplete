-- Artifact layers (PRD 11.11, ADR 0014). A layer may name the renderer that reads
-- it; NULL is the graph. A node may carry artifact details as one JSON object.
ALTER TABLE layers ADD COLUMN renderer TEXT CHECK (renderer IS NULL OR renderer = 'artifact');
ALTER TABLE nodes ADD COLUMN artifact TEXT CHECK (artifact IS NULL OR json_valid(artifact));

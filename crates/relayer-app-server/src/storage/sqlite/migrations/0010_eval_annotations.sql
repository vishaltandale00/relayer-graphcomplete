CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  anchor_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS annotations_thread_created ON annotations(thread_id, created_at, id);

CREATE TABLE IF NOT EXISTS annotation_revisions (
  annotation_id INTEGER NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  author_id TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  comment TEXT NOT NULL,
  rating INTEGER CHECK(rating BETWEEN 1 AND 4),
  state TEXT NOT NULL CHECK(state IN ('active', 'retracted')),
  navigation_context_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(annotation_id, revision)
);

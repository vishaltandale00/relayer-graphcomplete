-- The last Ladybug revision each logical target is known to have committed. A
-- target is a project when the closure belongs to one and a standalone thread
-- otherwise; both are columns on `nodes`.
--
-- Ladybug 0.18.0 has no revision of its own -- its Rust surface is query,
-- prepare, execute and interrupt -- so Relayer allocates the number and writes it
-- inside the Ladybug transaction as well. Holding the same number on both sides
-- is what makes an interrupted write detectable: a revision present in Ladybug
-- but not here is an orphan from a crash after Ladybug committed and before
-- SQLite did. SQLite is canonical, so reconciliation removes it from Ladybug and
-- never writes back the other way.
CREATE TABLE search_index_targets (
    target_kind TEXT NOT NULL CHECK(target_kind IN ('project', 'thread')),
    target_id INTEGER NOT NULL CHECK(target_id > 0),
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(target_kind, target_id)
);

-- The five versions that decide whether an existing store may be opened at all.
-- They live in SQLite, not in Ladybug, because they must be readable exactly when
-- the Ladybug store is corrupt or version-incompatible and will not open.
CREATE TABLE search_index_versions (
    component TEXT PRIMARY KEY CHECK(component IN (
        'engine',
        'storage_format',
        'relayer_schema',
        'query_contract',
        'derived_index'
    )),
    version TEXT NOT NULL
);

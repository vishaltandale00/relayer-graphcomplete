CREATE TABLE graph_import_asset_contents (
    import_id TEXT NOT NULL REFERENCES graph_imports(import_id) ON DELETE CASCADE,
    digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64),
    media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/svg+xml')),
    byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 8388608),
    content BLOB NOT NULL CHECK(length(content) = byte_length),
    PRIMARY KEY(import_id, digest_sha256)
);

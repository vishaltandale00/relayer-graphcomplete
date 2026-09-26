CREATE TABLE authored_detail_asset_contents (
    digest_sha256 TEXT PRIMARY KEY CHECK(length(digest_sha256) = 64),
    media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/svg+xml')),
    byte_length INTEGER NOT NULL CHECK(byte_length > 0),
    content BLOB NOT NULL CHECK(length(content) = byte_length)
);

CREATE TABLE authored_detail_assets (
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL,
    digest_sha256 TEXT NOT NULL REFERENCES authored_detail_asset_contents(digest_sha256),
    media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/svg+xml')),
    byte_length INTEGER NOT NULL CHECK(byte_length > 0),
    provenance_source TEXT NOT NULL CHECK(provenance_source IN ('user','system')),
    provenance_file_name TEXT NOT NULL,
    PRIMARY KEY(node_id, asset_id)
);

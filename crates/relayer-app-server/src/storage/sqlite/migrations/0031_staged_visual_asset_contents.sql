CREATE TABLE conversation_import_asset_contents (
    conversation_import_id TEXT NOT NULL REFERENCES conversation_imports(id) ON DELETE CASCADE,
    digest_sha256 TEXT NOT NULL,
    content_json TEXT NOT NULL,
    PRIMARY KEY(conversation_import_id,digest_sha256)
);
-- Upgrade durable stages created before streamed content had its own table.
INSERT INTO conversation_import_asset_contents(conversation_import_id,digest_sha256,content_json)
SELECT ci.id,json_extract(content.value,'$.digestSha256'),content.value
FROM conversation_imports ci,json_each(ci.header_json,'$.visualAssetContents') content;
UPDATE conversation_imports SET header_json=json_remove(header_json,'$.visualAssetContents')
WHERE json_type(header_json,'$.visualAssetContents') IS NOT NULL;

-- Content has no independent lifetime: drafts and accepted nodes own references.
CREATE INDEX authored_detail_assets_digest ON authored_detail_assets(digest_sha256);
CREATE TRIGGER reclaim_deleted_detail_asset_content
AFTER DELETE ON authored_detail_assets
BEGIN
    DELETE FROM authored_detail_asset_contents
    WHERE digest_sha256=OLD.digest_sha256
      AND NOT EXISTS (SELECT 1 FROM authored_detail_assets WHERE digest_sha256=OLD.digest_sha256);
END;
DELETE FROM authored_detail_asset_contents
WHERE NOT EXISTS (SELECT 1 FROM authored_detail_assets WHERE authored_detail_assets.digest_sha256=authored_detail_asset_contents.digest_sha256);

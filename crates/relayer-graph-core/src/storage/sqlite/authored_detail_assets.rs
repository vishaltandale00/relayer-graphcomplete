use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqliteConnection};

use crate::{AcceptedDetailAsset, GraphError, NodeId, PreparedDetailAsset};

pub(crate) struct AuthoredDetailAssetTable<'a> {
    connection: &'a mut SqliteConnection,
}

#[derive(FromRow)]
struct AssetRow {
    asset_id: String,
    digest_sha256: String,
    media_type: String,
    byte_length: i64,
    provenance_source: String,
    provenance_file_name: String,
    content: Vec<u8>,
}

impl<'a> AuthoredDetailAssetTable<'a> {
    pub(crate) fn new(connection: &'a mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn replace(
        &mut self,
        node_id: NodeId,
        assets: &[PreparedDetailAsset],
    ) -> Result<(), GraphError> {
        sqlx::query("DELETE FROM authored_detail_assets WHERE node_id=?1")
            .bind(node_id.value())
            .execute(&mut *self.connection)
            .await?;
        for asset in assets {
            self.materialize_content(
                &asset.digest_sha256,
                &asset.media_type,
                asset.byte_length,
                &asset.content,
            )
            .await?;
            sqlx::query("INSERT INTO authored_detail_assets(node_id,asset_id,digest_sha256,media_type,byte_length,provenance_source,provenance_file_name) VALUES (?1,?2,?3,?4,?5,?6,?7)")
                .bind(node_id.value()).bind(&asset.asset_id).bind(&asset.digest_sha256)
                .bind(&asset.media_type).bind(asset.byte_length as i64)
                .bind(&asset.provenance_source).bind(&asset.provenance_file_name)
                .execute(&mut *self.connection).await?;
        }
        Ok(())
    }

    async fn materialize_content(
        &mut self,
        digest: &str,
        media_type: &str,
        byte_length: usize,
        content: &[u8],
    ) -> Result<(), GraphError> {
        let actual = format!("{:x}", Sha256::digest(content));
        if actual != digest || content.len() != byte_length {
            return Err(GraphError::validation(
                "authored_detail_asset_integrity_mismatch",
                "authoredDetail.assets",
                "Prepared visual asset content does not match its pinned digest.",
            ));
        }
        sqlx::query("INSERT INTO authored_detail_asset_contents(digest_sha256,media_type,byte_length,content) VALUES (?1,?2,?3,?4) ON CONFLICT(digest_sha256) DO NOTHING")
                .bind(digest).bind(media_type)
                .bind(i64::try_from(byte_length).map_err(|_| GraphError::validation("authored_detail_asset_too_large", "authoredDetail.assets", "Visual asset is too large."))?)
                .bind(content).execute(&mut *self.connection).await?;
        let matches: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM authored_detail_asset_contents WHERE digest_sha256=?1 AND media_type=?2 AND byte_length=?3 AND content=?4)")
                .bind(digest).bind(media_type)
                .bind(byte_length as i64).bind(content)
                .fetch_one(&mut *self.connection).await?;
        if !matches {
            return Err(GraphError::validation(
                "authored_detail_asset_conflict",
                "authoredDetail.assets",
                "Pinned visual content conflicts with accepted history.",
            ));
        }
        Ok(())
    }

    pub(crate) async fn materialize_import_content(
        &mut self,
        import_id: &str,
        digest: &str,
    ) -> Result<(String, usize), GraphError> {
        let (media_type, byte_length, content): (String, i64, Vec<u8>) = sqlx::query_as(
            "SELECT media_type,byte_length,content FROM graph_import_asset_contents WHERE import_id=?1 AND digest_sha256=?2",
        ).bind(import_id).bind(digest).fetch_optional(&mut *self.connection).await?
            .ok_or_else(|| GraphError::validation("import_asset_content_missing", "authoredDetailAssets", "Imported visual asset content was not staged for this import."))?;
        let byte_length = usize::try_from(byte_length)
            .map_err(|_| GraphError::Internal("invalid staged asset length".into()))?;
        self.materialize_content(digest, &media_type, byte_length, &content)
            .await?;
        Ok((media_type, byte_length))
    }

    pub(crate) async fn insert_import_reference(
        &mut self,
        node_id: NodeId,
        asset: &crate::ImportedDetailAsset,
    ) -> Result<(), GraphError> {
        sqlx::query("INSERT INTO authored_detail_assets(node_id,asset_id,digest_sha256,media_type,byte_length,provenance_source,provenance_file_name) VALUES (?1,?2,?3,?4,?5,?6,?7)")
            .bind(node_id.value()).bind(&asset.asset_id).bind(&asset.digest_sha256)
            .bind(&asset.media_type).bind(asset.byte_length as i64)
            .bind(&asset.provenance_source).bind(&asset.provenance_file_name)
            .execute(&mut *self.connection).await?;
        Ok(())
    }

    pub(crate) async fn read(
        &mut self,
        node_id: NodeId,
        asset_id: &str,
    ) -> Result<AcceptedDetailAsset, GraphError> {
        let row = sqlx::query_as::<_, AssetRow>("SELECT asset.asset_id,asset.digest_sha256,asset.media_type,asset.byte_length,asset.provenance_source,asset.provenance_file_name,content.content FROM authored_detail_assets asset JOIN authored_detail_asset_contents content USING(digest_sha256) JOIN nodes node ON node.id=asset.node_id WHERE asset.node_id=?1 AND asset.asset_id=?2 AND node.state='accepted'")
            .bind(node_id.value()).bind(asset_id).fetch_optional(&mut *self.connection).await?
            .ok_or_else(|| GraphError::NotFound("accepted visual asset".into()))?;
        Ok(AcceptedDetailAsset {
            asset_id: row.asset_id,
            digest_sha256: row.digest_sha256,
            media_type: row.media_type,
            byte_length: usize::try_from(row.byte_length)
                .map_err(|_| GraphError::Internal("invalid accepted visual asset size".into()))?,
            provenance_source: row.provenance_source,
            provenance_file_name: row.provenance_file_name,
            content: row.content,
        })
    }
}

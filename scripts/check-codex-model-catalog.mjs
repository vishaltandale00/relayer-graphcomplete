import { CodexCredentialAdapter } from "../desktop/main/credentials/codex-credential-adapter.mjs";
import { CodexModelCatalogAdapter } from "../desktop/main/models/codex-model-catalog-adapter.mjs";

const credentials = new CodexCredentialAdapter();
try {
  const snapshot = await new CodexModelCatalogAdapter({ credentials }).discover();
  console.log(JSON.stringify({
    provider: snapshot.provider,
    models: snapshot.models.map((model) => ({
      id: model.id,
      executionModel: model.executionModel,
      visible: model.visible,
      availability: model.availability,
      isDefault: model.isDefault,
      replacementModelId: model.replacementModelId,
    })),
    systemFamily: snapshot.systemFamily,
  }, null, 2));
  if (snapshot.provider.status !== "available") process.exitCode = 1;
} finally {
  await credentials.close();
}

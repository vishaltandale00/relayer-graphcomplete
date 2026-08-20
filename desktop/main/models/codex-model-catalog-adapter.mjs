import { ModelCatalogAdapter, sanitizeModelCatalogSnapshot } from "./model-catalog-adapter.mjs";

const CODEX_PROVIDER_ID = "codex";
const CODEX_PROVIDER_LABEL = "Codex";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 100;

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function normalizeUpgradeInfo(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const modelId = optionalString(value.model);
  if (modelId === null) return null;
  return {
    modelId,
    copy: optionalString(value.upgradeCopy),
    link: optionalString(value.modelLink),
    migrationMarkdown: optionalString(value.migrationMarkdown),
  };
}

function normalizeEfforts(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    const id = optionalString(option?.reasoningEffort);
    if (id === null) return [];
    return [{ id, description: typeof option.description === "string" ? option.description : "" }];
  });
}

function normalizeServiceTiers(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tier) => {
    const id = optionalString(tier?.id);
    const name = optionalString(tier?.name);
    if (id === null || name === null) return [];
    return [{ id, name, description: typeof tier.description === "string" ? tier.description : "" }];
  });
}

function normalizeCodexModel(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex model/list returned a non-object model entry.");
  }
  const catalogId = optionalString(value.id);
  const executionModel = optionalString(value.model);
  const label = optionalString(value.displayName);
  if (catalogId === null || executionModel === null || label === null) {
    throw new Error("Codex model/list returned a model without id, model, or displayName.");
  }
  return {
    // Product model identity must be the literal value accepted by Codex execution.
    // Preserve model/list's catalog-local id separately for diagnostics/metadata.
    id: executionModel,
    catalogId,
    executionModel,
    label,
    description: typeof value.description === "string" ? value.description : "",
    visible: value.hidden !== true,
    // Codex model/list is the current account-aware catalog. availabilityNux is
    // preserved as a notice and is not guessed to mean unavailable.
    availability: "available",
    unavailableReason: null,
    availabilityNotice: optionalString(value.availabilityNux?.message),
    isDefault: value.isDefault === true,
    replacementModelId: optionalString(value.upgrade),
    upgradeInfo: normalizeUpgradeInfo(value.upgradeInfo),
    supportedEfforts: normalizeEfforts(value.supportedReasoningEfforts),
    defaultEffort: optionalString(value.defaultReasoningEffort),
    inputModalities: Array.isArray(value.inputModalities) ? value.inputModalities : ["text", "image"],
    supportsPersonality: value.supportsPersonality === true,
    serviceTiers: normalizeServiceTiers(value.serviceTiers),
    defaultServiceTier: optionalString(value.defaultServiceTier),
  };
}

export class CodexModelCatalogAdapter extends ModelCatalogAdapter {
  constructor({ credentials, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    super({ providerId: CODEX_PROVIDER_ID, providerLabel: CODEX_PROVIDER_LABEL });
    if (!credentials || typeof credentials.account !== "function" || typeof credentials.request !== "function") {
      throw new Error("Codex model discovery requires a Codex credential adapter.");
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("Codex model-list pageSize must be a positive integer.");
    this.credentials = credentials;
    this.pageSize = pageSize;
  }

  async discover({ signal } = {}) {
    signal?.throwIfAborted();
    const account = await this.credentials.account({ signal });
    signal?.throwIfAborted();
    if (account?.status === "unavailable") {
      return sanitizeModelCatalogSnapshot({
        provider: {
          id: this.providerId,
          label: this.providerLabel,
          status: "unavailable",
          unavailableReason: optionalString(account.error) || "Codex is unavailable.",
        },
        models: [],
        systemFamily: { id: this.providerId, label: this.providerLabel, modelIds: [] },
      });
    }
    if (account?.status !== "connected") {
      return sanitizeModelCatalogSnapshot({
        provider: {
          id: this.providerId,
          label: this.providerLabel,
          status: "disconnected",
          unavailableReason: null,
        },
        models: [],
        systemFamily: { id: this.providerId, label: this.providerLabel, modelIds: [] },
      });
    }

    const rawModels = [];
    const seenCursors = new Set();
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.credentials.request("model/list", {
        cursor,
        limit: this.pageSize,
        includeHidden: true,
      }, undefined, signal);
      signal?.throwIfAborted();
      if (!Array.isArray(result?.data)) throw new Error("Codex model/list returned an invalid data page.");
      rawModels.push(...result.data);
      const nextCursor = optionalString(result.nextCursor);
      if (nextCursor === null) {
        cursor = null;
        break;
      }
      if (seenCursors.has(nextCursor)) throw new Error("Codex model/list repeated a pagination cursor.");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (page === MAX_PAGES - 1) throw new Error("Codex model/list exceeded the pagination safety limit.");
    }

    const models = rawModels.map(normalizeCodexModel);
    return sanitizeModelCatalogSnapshot({
      provider: {
        id: this.providerId,
        label: this.providerLabel,
        status: "available",
        unavailableReason: null,
      },
      models,
      systemFamily: {
        id: this.providerId,
        label: this.providerLabel,
        modelIds: models.filter((model) => model.visible).slice(0, 5).map((model) => model.id),
      },
    });
  }
}

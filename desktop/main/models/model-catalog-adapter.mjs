const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const PROVIDER_STATUSES = new Set(["available", "disconnected", "unavailable"]);
const MODEL_AVAILABILITY = new Set(["available", "unavailable"]);

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  return nonEmptyString(value, field);
}

function stableIdString(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a stable identifier.`);
  const characters = [...value];
  if (characters.length === 0
    || characters.length > 200
    || /\p{White_Space}/u.test(characters[0])
    || /\p{White_Space}/u.test(characters.at(-1))
    || characters.some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character))
    || characters.some((character) => /\p{Cc}/u.test(character))) {
    throw new Error(`${field} must be a stable identifier.`);
  }
  return value;
}

function optionalStableIdString(value, field) {
  if (value === undefined || value === null) return null;
  return stableIdString(value, field);
}

function boolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function stringList(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return Object.freeze(value.map((item, index) => nonEmptyString(item, `${field}[${index}]`)));
}

function stableIdList(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return Object.freeze(value.map((item, index) => stableIdString(item, `${field}[${index}]`)));
}

function sanitizeEfforts(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return Object.freeze(value.map((item, index) => Object.freeze({
    id: nonEmptyString(item?.id, `${field}[${index}].id`),
    description: typeof item?.description === "string" ? item.description : "",
  })));
}

function sanitizeServiceTiers(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return Object.freeze(value.map((item, index) => Object.freeze({
    id: nonEmptyString(item?.id, `${field}[${index}].id`),
    name: nonEmptyString(item?.name, `${field}[${index}].name`),
    description: typeof item?.description === "string" ? item.description : "",
  })));
}

function sanitizeUpgradeInfo(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return Object.freeze({
    modelId: stableIdString(value.modelId, `${field}.modelId`),
    copy: optionalString(value.copy, `${field}.copy`),
    link: optionalString(value.link, `${field}.link`),
    migrationMarkdown: optionalString(value.migrationMarkdown, `${field}.migrationMarkdown`),
  });
}

function sanitizeModel(model, providerId, index) {
  const field = `models[${index}]`;
  const availability = nonEmptyString(model?.availability, `${field}.availability`);
  if (!MODEL_AVAILABILITY.has(availability)) {
    throw new Error(`${field}.availability must be available or unavailable.`);
  }
  const unavailableReason = optionalString(model?.unavailableReason, `${field}.unavailableReason`);
  if (availability === "unavailable" && unavailableReason === null) {
    throw new Error(`${field}.unavailableReason is required when a model is unavailable.`);
  }
  return Object.freeze({
    providerId,
    id: stableIdString(model?.id, `${field}.id`),
    catalogId: stableIdString(model?.catalogId ?? model?.id, `${field}.catalogId`),
    executionModel: stableIdString(model?.executionModel, `${field}.executionModel`),
    label: nonEmptyString(model?.label, `${field}.label`),
    description: typeof model?.description === "string" ? model.description : "",
    order: index,
    visible: boolean(model?.visible, `${field}.visible`),
    availability,
    unavailableReason,
    availabilityNotice: optionalString(model?.availabilityNotice, `${field}.availabilityNotice`),
    isDefault: boolean(model?.isDefault, `${field}.isDefault`),
    replacementModelId: optionalStableIdString(model?.replacementModelId, `${field}.replacementModelId`),
    upgradeInfo: sanitizeUpgradeInfo(model?.upgradeInfo, `${field}.upgradeInfo`),
    supportedEfforts: sanitizeEfforts(model?.supportedEfforts, `${field}.supportedEfforts`),
    defaultEffort: optionalString(model?.defaultEffort, `${field}.defaultEffort`),
    inputModalities: stringList(model?.inputModalities, `${field}.inputModalities`),
    supportsPersonality: boolean(model?.supportsPersonality, `${field}.supportsPersonality`),
    serviceTiers: sanitizeServiceTiers(model?.serviceTiers, `${field}.serviceTiers`),
    defaultServiceTier: optionalString(model?.defaultServiceTier, `${field}.defaultServiceTier`),
    catalogSource: optionalString(model?.catalogSource, `${field}.catalogSource`),
  });
}

export class ModelCatalogAdapter {
  constructor({ providerId, providerLabel }) {
    this.providerId = stableIdString(providerId, "providerId");
    if (!PROVIDER_ID_PATTERN.test(this.providerId)) {
      throw new Error("providerId must contain only lowercase letters, numbers, dots, underscores, or hyphens.");
    }
    this.providerLabel = nonEmptyString(providerLabel, "providerLabel");
  }

  discover() {
    throw new Error("ModelCatalogAdapter.discover() must be implemented.");
  }
}

export function sanitizeModelCatalogSnapshot(snapshot) {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new Error("A model catalog snapshot must be an object.");
  }
  const providerId = stableIdString(snapshot.provider?.id, "provider.id");
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error("provider.id is invalid.");
  const status = nonEmptyString(snapshot.provider?.status, "provider.status");
  if (!PROVIDER_STATUSES.has(status)) throw new Error("provider.status is invalid.");
  const unavailableReason = optionalString(snapshot.provider?.unavailableReason, "provider.unavailableReason");
  if (status === "unavailable" && unavailableReason === null) {
    throw new Error("provider.unavailableReason is required when a provider is unavailable.");
  }
  if (!Array.isArray(snapshot.models)) throw new Error("models must be an array.");
  const models = Object.freeze(snapshot.models.map((model, index) => sanitizeModel(model, providerId, index)));
  const modelIds = new Set();
  for (const model of models) {
    if (modelIds.has(model.id)) throw new Error(`Duplicate provider model id: ${model.id}`);
    modelIds.add(model.id);
  }

  const systemFamily = snapshot.systemFamily;
  if (typeof systemFamily !== "object" || systemFamily === null || Array.isArray(systemFamily)) {
    throw new Error("systemFamily must be an object.");
  }
  const familyModelIds = stableIdList(systemFamily.modelIds, "systemFamily.modelIds");
  if (familyModelIds.length > 5) throw new Error("A system model family cannot contain more than five models.");
  const familyIds = new Set();
  for (const modelId of familyModelIds) {
    if (familyIds.has(modelId)) throw new Error(`Duplicate system-family model id: ${modelId}`);
    familyIds.add(modelId);
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`System-family model does not exist in the provider catalog: ${modelId}`);
    if (!model.visible) {
      throw new Error(`System-family model must be visible: ${modelId}`);
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    provider: Object.freeze({
      id: providerId,
      label: nonEmptyString(snapshot.provider?.label, "provider.label"),
      status,
      unavailableReason,
    }),
    models,
    systemFamily: Object.freeze({
      id: stableIdString(systemFamily.id, "systemFamily.id"),
      label: nonEmptyString(systemFamily.label, "systemFamily.label"),
      readOnly: true,
      modelIds: familyModelIds,
    }),
  });
}

export function unavailableModelCatalogSnapshot(adapter, reason) {
  return sanitizeModelCatalogSnapshot({
    provider: {
      id: adapter.providerId,
      label: adapter.providerLabel,
      status: "unavailable",
      unavailableReason: reason instanceof Error ? reason.message : String(reason || "Provider catalog is unavailable."),
    },
    models: [],
    systemFamily: {
      id: adapter.providerId,
      label: adapter.providerLabel,
      modelIds: [],
    },
  });
}

export function toProductCatalogSnapshot(snapshot) {
  const sanitized = sanitizeModelCatalogSnapshot(snapshot);
  return Object.freeze({
    providerId: sanitized.provider.id,
    label: sanitized.provider.label,
    connected: sanitized.provider.status === "available",
    ...(sanitized.provider.status === "unavailable" ? {
      unavailableReason: Object.freeze({
        code: "provider_unavailable",
        message: sanitized.provider.unavailableReason,
      }),
    } : {}),
    models: Object.freeze(sanitized.models.map((model) => Object.freeze({
      id: model.id,
      label: model.label,
      order: model.order,
      visible: model.visible,
      available: model.availability === "available",
      ...(model.availability === "unavailable" ? {
        unavailableReason: Object.freeze({
          code: "provider_reported_unavailable",
          message: model.unavailableReason,
        }),
      } : {}),
      providerDefault: model.isDefault,
      ...(model.replacementModelId === null ? {} : { replacementModelId: model.replacementModelId }),
      metadata: Object.freeze({
        catalogId: model.catalogId,
        executionModel: model.executionModel,
        description: model.description,
        availabilityNotice: model.availabilityNotice,
        upgradeInfo: model.upgradeInfo,
        supportedEfforts: model.supportedEfforts,
        defaultEffort: model.defaultEffort,
        inputModalities: model.inputModalities,
        supportsPersonality: model.supportsPersonality,
        serviceTiers: model.serviceTiers,
        defaultServiceTier: model.defaultServiceTier,
        catalogSource: model.catalogSource,
      }),
    }))),
    ...(sanitized.systemFamily.modelIds.length === 0 ? {} : {
      systemFamily: Object.freeze({
        key: sanitized.systemFamily.id,
        name: sanitized.systemFamily.label,
        modelIds: sanitized.systemFamily.modelIds,
      }),
    }),
  });
}

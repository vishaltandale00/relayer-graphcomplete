const modelIdentity = (model) => String(model.modelId ?? model.id ?? "");

export function providerModelsNewestFirst(models, query = "") {
  const normalizedQuery = String(query).trim().toLocaleLowerCase("en");
  return [...(models ?? [])]
    .filter((model) => {
      if (!normalizedQuery) return true;
      return `${model.label ?? ""}\n${modelIdentity(model)}`.toLocaleLowerCase("en").includes(normalizedQuery);
    })
    .sort((left, right) => (Number.isSafeInteger(left.displayOrder) && Number.isSafeInteger(right.displayOrder)
      ? left.displayOrder - right.displayOrder
      : 0));
}

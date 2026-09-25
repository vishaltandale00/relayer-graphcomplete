/** Matches the shared natural-language query grammar; case admission stays with each grader. */
export function isNaturalGraphMemoryQueryShape(
  query: string,
  parameterName: string,
  flags: "i" | "iu" = "i",
): boolean {
  const identifier = "[A-Za-z_][A-Za-z0-9_]*";
  const layer = `(?<layer>${identifier})`;
  const content = `(?<content>${identifier})`;
  const relationship = `\\[\\s*(?:${identifier}\\s*)?:\\s*CONTAINS(?:\\s*\\{[^}]*\\})?\\s*\\]`;
  const contains = `\\s*-\\s*${relationship}\\s*->\\s*`;
  const containedBy = `\\s*<-\\s*${relationship}\\s*-\\s*`;
  const layerNode = `\\(\\s*${layer}\\s*:\\s*Layer\\s*\\)`;
  const contentNode = `\\(\\s*${content}\\s*:\\s*Content\\s*\\)`;
  const escapedParameter = parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titleProperty = "\\k<content>\\s*\\.\\s*title";
  const parameter = `\\$${escapedParameter}`;
  const predicate = `\\s+WHERE\\s+(?:${titleProperty}\\s*=\\s*${parameter}|${parameter}\\s*=\\s*${titleProperty})`;
  const projection = `\\s+RETURN\\s+(?:DISTINCT\\s+)?\\k<layer>(?:\\s+AS\\s+${identifier})?`;
  const orderingExpression = `${identifier}(?:\\s*\\.\\s*${identifier})?`;
  const ordering = `(?:\\s+ORDER\\s+BY\\s+${orderingExpression}(?:\\s+(?:ASC|DESC))?)?`;
  const limit = "(?:\\s+LIMIT\\s+[1-8])?\\s*;?\\s*$";
  const pathBinding = `(?:${identifier}\\s*=\\s*)?`;
  const forward = new RegExp(`^\\s*MATCH\\s+${pathBinding}${layerNode}${contains}${contentNode}${predicate}${projection}${ordering}${limit}`, flags);
  const reverse = new RegExp(`^\\s*MATCH\\s+${pathBinding}${contentNode}${containedBy}${layerNode}${predicate}${projection}${ordering}${limit}`, flags);
  return forward.test(query) || reverse.test(query);
}

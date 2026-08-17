export const MAX_NUMERIC_VERSION_COMPONENT_DIGITS = 32;

const numericVersionPattern = new RegExp(
  `^((?:0|[1-9]\\d{0,${MAX_NUMERIC_VERSION_COMPONENT_DIGITS - 1}}))\\.((?:0|[1-9]\\d{0,${MAX_NUMERIC_VERSION_COMPONENT_DIGITS - 1}}))\\.((?:0|[1-9]\\d{0,${MAX_NUMERIC_VERSION_COMPONENT_DIGITS - 1}}))$`,
);

export function parseNumericVersion(value) {
  const match = numericVersionPattern.exec(String(value ?? "").trim());
  return match ? match.slice(1) : null;
}

export function compareNumericVersions(left, right) {
  const leftParts = parseNumericVersion(left);
  const rightParts = parseNumericVersion(right);
  if (!leftParts || !rightParts) return null;

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index].length !== rightParts[index].length) {
      return leftParts[index].length < rightParts[index].length ? -1 : 1;
    }
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function isNumericVersion(value) {
  return parseNumericVersion(value) !== null;
}

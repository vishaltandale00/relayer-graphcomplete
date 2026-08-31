// Shared validation primitives for the authenticated error reporting pipeline.
// Each trust boundary keeps its own validation, but the primitives they build on
// are defined once here so a hardening fix cannot land in only one copy.

// Largest accepted source line or column. Real sources never approach this, and
// the bound keeps a compromised producer from smuggling data out through the
// numeric fields of an otherwise approved frame.
export const MAX_SOURCE_POSITION = 10_000_000;

// True when `value` is a plain object whose own keys are exactly `keys`.
// Comparing the key count and membership individually avoids the delimiter
// collision a joined-string comparison allows, where one key containing the
// delimiter can impersonate several.
export function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function validSourcePosition(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SOURCE_POSITION;
}

// Single-pass substitution: task text cannot introduce another template variable.
export function renderSetupPrompt(template, values) {
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown setup prompt variable: ${key}`);
    return String(values[key]);
  });
}

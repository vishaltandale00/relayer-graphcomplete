function matcher(rule) {
  return rule.modelIdRegex !== undefined ? "regex" : "exact";
}

function pattern(rule) {
  return rule.modelIdRegex ?? rule.modelIdExact ?? "";
}

function validStableId(value) {
  return value.length > 0 && value.trim() === value && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function validateHarnessRules(rules) {
  const errors = {};
  const seen = new Set();
  const total = (rules.allow?.length ?? 0) + (rules.deny?.length ?? 0);
  if (total > 100) errors.form = "Use no more than 100 model rules.";
  for (const effect of ["allow", "deny"]) {
    (rules[effect] ?? []).forEach((rule, index) => {
      const key = `${effect}.${index}`;
      if (!validStableId(rule.adapterId ?? "")) errors[`${key}.adapterId`] = "Enter a valid adapter ID.";
      const type = matcher(rule);
      const value = pattern(rule);
      if (type === "exact" && !validStableId(value)) errors[`${key}.pattern`] = "Enter an exact model ID.";
      if (type === "regex") {
        if (!value || value.length > 500) errors[`${key}.pattern`] = "Enter a regex of 500 characters or fewer.";
        else if (value.includes("(?") || /\\(?:[1-9kAzZG])/.test(value)) errors[`${key}.pattern`] = "This regex uses unsupported cross-runtime syntax.";
        else {
          try { new RegExp(value); } catch { errors[`${key}.pattern`] = "Enter a valid model regex."; }
        }
      }
      const duplicate = `${effect}\0${rule.adapterId}\0${type}\0${value}`;
      if (seen.has(duplicate)) errors[`${key}.pattern`] = "Remove this duplicate rule.";
      seen.add(duplicate);
    });
  }
  return errors;
}

export function usableHarnessPresentations(settings) {
  return (settings?.harnesses ?? []).flatMap((harness) => {
    if (!harness.usableNow) return [];
    return [{
      harness,
      isDefault: harness.id === settings?.defaults?.harnessId,
    }];
  });
}

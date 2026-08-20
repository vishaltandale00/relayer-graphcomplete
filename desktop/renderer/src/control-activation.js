const activationCompletion = new WeakMap();

export function setControlActivationCompletion(element, completion) {
  if (!element || typeof completion?.then !== "function") {
    throw new TypeError("Control activation completion requires an element and promise.");
  }
  activationCompletion.set(element, completion);
  return completion;
}

export function controlActivationCompletionFor(element) {
  return activationCompletion.get(element) ?? null;
}

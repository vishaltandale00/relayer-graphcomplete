export const TUTORIAL_VERSION = 1;

const TERMINAL_STATUSES = new Set(["dismissed", "completed"]);

function tutorialStatus(settings) {
  const tutorial = settings?.tutorial;
  if (tutorial === undefined) return "never-shown";
  if (
    tutorial
    && typeof tutorial === "object"
    && !Array.isArray(tutorial)
    && tutorial.version === TUTORIAL_VERSION
    && TERMINAL_STATUSES.has(tutorial.status)
  ) {
    return tutorial.status;
  }
  // An older, newer, or malformed marker must not unexpectedly relaunch onboarding.
  return "dismissed";
}

function automaticContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Tutorial context must be an object.");
  }
  if (value.surface !== "product") {
    throw new TypeError("Automatic tutorials are available only in the writable product surface.");
  }
  if (typeof value.providerConnected !== "boolean") {
    throw new TypeError("Tutorial providerConnected must be a boolean.");
  }
  if (!Number.isSafeInteger(value.threadCount) || value.threadCount < 0) {
    throw new TypeError("Tutorial threadCount must be a non-negative integer.");
  }
  return value;
}

function stateFor(settings, context) {
  const status = tutorialStatus(settings);
  return {
    status,
    automaticEligible: status === "never-shown"
      && context.surface === "product"
      && context.providerConnected
      && context.threadCount === 0,
  };
}

function terminalSettings(settings, status) {
  const current = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  return {
    ...current,
    tutorial: { version: TUTORIAL_VERSION, status },
  };
}

export function createTutorialLifecycle({ settings }) {
  if (!settings?.read || !settings?.update) {
    throw new TypeError("Tutorial lifecycle requires a readable, updateable settings store.");
  }

  return {
    async read(contextValue) {
      const context = automaticContext(contextValue);
      return stateFor(await settings.read(), context);
    },

    async beginAutomatic(contextValue) {
      const context = automaticContext(contextValue);
      let started = false;
      const next = await settings.update((current) => {
        if (!stateFor(current, context).automaticEligible) return current;
        started = true;
        // There is deliberately no active/resumable state. Starting once is enough
        // to prevent another automatic launch if the user leaves or closes the app.
        return terminalSettings(current, "dismissed");
      });
      return {
        ...stateFor(next, context),
        started,
        source: "automatic",
      };
    },

    async beginManual() {
      const next = await settings.update((current) => (
        tutorialStatus(current) === "never-shown"
          ? terminalSettings(current, "dismissed")
          : current
      ));
      return {
        status: tutorialStatus(next),
        started: true,
        source: "manual",
      };
    },

    async dismiss() {
      const next = await settings.update((current) => terminalSettings(
        current,
        tutorialStatus(current) === "completed" ? "completed" : "dismissed",
      ));
      return { status: tutorialStatus(next) };
    },

    async complete() {
      const next = await settings.update((current) => terminalSettings(current, "completed"));
      return { status: tutorialStatus(next) };
    },
  };
}

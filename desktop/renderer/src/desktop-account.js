export const ACCOUNT_ONBOARDING_PREFERENCE_KEY = "relayerDesktopAccountOnboardingV1";

export function revealDesktopWorkspace(showApplication, body = document.body) {
  body.classList.remove("desktop-account-pending");
  showApplication();
}

const STATUSES = new Set(["signed-out", "signing-in", "signed-in", "uncertain", "error"]);
const REASONS = new Set(["offline", "unverifiable", "authentication-failed", "storage-unavailable"]);

export function normalizeDesktopAccountState(value) {
  const source = value && typeof value === "object" ? value : {};
  const status = STATUSES.has(source.status) ? source.status : "error";
  const channel = source.channel === "preview" ? "preview" : "stable";
  const state = { status, channel };
  if ((status === "signed-in" || status === "uncertain") && typeof source.subject === "string" && source.subject) {
    state.subject = source.subject.slice(0, 256);
  }
  if (status === "uncertain" || status === "error") {
    state.reason = REASONS.has(source.reason) ? source.reason : "authentication-failed";
  }
  return state;
}

function reasonLabel(reason) {
  if (reason === "offline") return "Account unavailable offline";
  if (reason === "unverifiable") return "Account could not be verified";
  if (reason === "storage-unavailable") return "Secure account storage unavailable";
  return "Account status unavailable";
}

function presentation(state) {
  if (state.status === "signed-in") {
    return {
      accountButton: "Account",
      status: "Signed in",
      canSignIn: false,
      canLogout: true,
    };
  }
  if (state.status === "signing-in") {
    return {
      accountButton: "Signing in…",
      status: "Finish signing in in your browser",
      canSignIn: false,
      canLogout: false,
    };
  }
  if (state.status === "uncertain" || state.status === "error") {
    return {
      accountButton: state.status === "error" ? "Sign in" : "Account",
      status: reasonLabel(state.reason),
      canSignIn: state.status === "error",
      canLogout: state.status === "uncertain",
    };
  }
  return {
    accountButton: "Sign in",
    status: "Signed out",
    canSignIn: true,
    canLogout: false,
  };
}

export function createDesktopAccountController({ api, elements, storage, openSettings, showWorkspace = () => {} }) {
  let current = normalizeDesktopAccountState(null);
  let bound = false;
  let workspaceShown = false;
  let loginInFlight = false;

  function onboardingPreference() {
    try {
      return storage.getItem(ACCOUNT_ONBOARDING_PREFERENCE_KEY);
    } catch {
      return null;
    }
  }

  function rememberOnboardingPreference(value) {
    try {
      storage.setItem(ACCOUNT_ONBOARDING_PREFERENCE_KEY, value);
    } catch {
      // Preference persistence is best effort and must never block local use.
    }
  }

  function finishOnboarding() {
    elements.onboarding.classList.add("hidden");
    elements.accountButton.classList.remove("hidden");
    if (workspaceShown) return;
    workspaceShown = true;
    showWorkspace();
  }

  function offerStandaloneOnboarding() {
    elements.accountButton.classList.add("hidden");
    elements.onboarding.classList.remove("hidden");
    elements.onboardingSignIn.focus();
  }

  function render(value, { offerOnboarding = false } = {}) {
    current = normalizeDesktopAccountState(value);
    const copy = presentation(current);
    const directSignIn = current.status === "signed-out" || current.status === "error";
    (elements.accountLabel ?? elements.accountButton).textContent = copy.accountButton;
    elements.accountButton.setAttribute("aria-label", directSignIn
      ? "Sign in to Relayer."
      : `${copy.accountButton}. Open Account settings.`);
    elements.accountButton.setAttribute("title", current.status === "signing-in"
      ? "Signing in…"
      : directSignIn ? "Sign in" : "Account");
    elements.accountButton.disabled = loginInFlight || current.status === "signing-in";
    elements.settingsStatus.textContent = copy.status;
    elements.settingsSignIn.classList.toggle("hidden", !copy.canSignIn);
    elements.settingsLogout.classList.toggle("hidden", !copy.canLogout);
    elements.settingsSignIn.disabled = loginInFlight || current.status === "signing-in";
    elements.settingsLogout.disabled = current.status === "signing-in";
    elements.onboardingChannel.textContent = "Optional account";
    elements.onboardingStatus.textContent = "Sign in to connect privacy-filtered error reports to a pseudonymous account. Your projects and conversations stay local, and you can continue without an account.";
    elements.onboardingSignIn.disabled = loginInFlight || current.status === "signing-in";
    const automaticOffer = offerOnboarding
      && (current.status === "signed-out" || current.status === "error")
      && onboardingPreference() === null;
    if (automaticOffer) {
      offerStandaloneOnboarding();
    } else if (offerOnboarding) {
      finishOnboarding();
    }
    if (current.status === "signed-in" && !elements.onboarding.classList.contains("hidden")) {
      rememberOnboardingPreference("completed");
      finishOnboarding();
    }
    return current;
  }

  async function invoke(action) {
    try {
      return render(await action());
    } catch {
      return render({ status: "error", channel: current.channel, reason: "authentication-failed" });
    }
  }

  async function signIn() {
    if (loginInFlight) return current;
    loginInFlight = true;
    render({ status: "signing-in", channel: current.channel });
    let result;
    try {
      result = await api.login();
    } catch {
      result = { status: "error", channel: current.channel, reason: "authentication-failed" };
    }
    loginInFlight = false;
    return render(result);
  }

  function bind() {
    if (bound) return;
    bound = true;
    elements.accountButton.onclick = () => {
      if (current.status === "signed-out" || current.status === "error") {
        void signIn();
      } else {
        openSettings();
      }
    };
    elements.onboardingNotNow.onclick = () => {
      rememberOnboardingPreference("dismissed");
      finishOnboarding();
    };
    elements.onboardingSignIn.onclick = () => void signIn();
    elements.settingsSignIn.onclick = () => void signIn();
    elements.settingsLogout.onclick = () => void invoke(api.logout);
    api.onChanged((value) => render(value));
  }

  return {
    async start(options) {
      bind();
      try {
        return render(await api.read(), options);
      } catch {
        return render({ status: "error", channel: current.channel, reason: "authentication-failed" }, options);
      }
    },
    async refresh(options) {
      try {
        return render(await api.read(), options);
      } catch {
        return render({ status: "error", channel: current.channel, reason: "authentication-failed" }, options);
      }
    },
  };
}

let accountController;

function accountElements() {
  const byId = (id) => document.getElementById(id);
  return {
    accountButton: byId("desktopAccountButton"),
    accountLabel: byId("desktopAccountLabel"),
    onboarding: byId("desktopAccountOnboarding"),
    onboardingChannel: byId("desktopAccountOnboardingChannel"),
    onboardingStatus: byId("desktopAccountOnboardingStatus"),
    onboardingSignIn: byId("desktopAccountOnboardingSignIn"),
    onboardingNotNow: byId("desktopAccountOnboardingNotNow"),
    settingsStatus: byId("desktopAccountStatus"),
    settingsSignIn: byId("desktopAccountSignIn"),
    settingsLogout: byId("desktopAccountLogout"),
  };
}

export async function initializeDesktopAccountUi({ desktop, openSettings, showWorkspace, offerOnboarding = false }) {
  const accountButton = document.getElementById("desktopAccountButton");
  if (!desktop?.account) {
    accountButton?.classList.add("hidden");
    showWorkspace?.();
    return null;
  }
  accountController = createDesktopAccountController({
    api: desktop.account,
    elements: accountElements(),
    storage: localStorage,
    openSettings,
    showWorkspace,
  });
  return accountController.start({ offerOnboarding });
}

export async function refreshDesktopAccountUi(options) {
  return accountController?.refresh(options);
}

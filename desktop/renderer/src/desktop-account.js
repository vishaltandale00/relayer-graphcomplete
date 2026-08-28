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
  const channel = state.channel === "preview" ? "Preview" : "Stable";
  if (state.status === "signed-in") {
    return {
      accountButton: "Account",
      status: "Signed in",
      detail: `Pseudonymous account ID: ${state.subject ?? "Unavailable"}. Privacy-filtered error reports may be associated with this ID.`,
      channel,
      canSignIn: false,
      canLogout: true,
    };
  }
  if (state.status === "signing-in") {
    return {
      accountButton: "Signing in…",
      status: "Finish signing in in your browser",
      detail: "Relayer remains fully usable while sign-in is in progress.",
      channel,
      canSignIn: false,
      canLogout: false,
    };
  }
  if (state.status === "uncertain" || state.status === "error") {
    return {
      accountButton: "Account",
      status: reasonLabel(state.reason),
      detail: "Local features remain available. Error reporting is paused until the account can be verified.",
      channel,
      canSignIn: state.status === "error",
      canLogout: state.status === "uncertain",
    };
  }
  return {
    accountButton: "Sign in",
    status: "Signed out",
    detail: "Sign in to associate privacy-filtered error reports with a pseudonymous account ID. Relayer's local features do not require an account.",
    channel,
    canSignIn: true,
    canLogout: false,
  };
}

export function createDesktopAccountController({ api, elements, storage, openSettings, showWorkspace = () => {} }) {
  let current = normalizeDesktopAccountState(null);
  let bound = false;
  let workspaceShown = false;

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
    elements.accountButton.textContent = copy.accountButton;
    elements.accountButton.setAttribute("aria-label", `${copy.accountButton}. Open Account settings.`);
    elements.settingsStatus.textContent = copy.status;
    elements.settingsDetail.textContent = copy.detail;
    elements.settingsChannel.textContent = copy.channel;
    elements.settingsSignIn.classList.toggle("hidden", !copy.canSignIn);
    elements.settingsLogout.classList.toggle("hidden", !copy.canLogout);
    elements.settingsSignIn.disabled = current.status === "signing-in";
    elements.settingsLogout.disabled = current.status === "signing-in";
    elements.onboardingChannel.textContent = "Optional account";
    elements.onboardingStatus.textContent = "Sign in to connect privacy-filtered error reports to a pseudonymous account. Your projects and conversations stay local, and you can continue without an account.";
    elements.onboardingSignIn.disabled = current.status === "signing-in";
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

  function bind() {
    if (bound) return;
    bound = true;
    elements.accountButton.onclick = () => openSettings();
    elements.onboardingNotNow.onclick = () => {
      rememberOnboardingPreference("dismissed");
      finishOnboarding();
    };
    elements.onboardingSignIn.onclick = () => void invoke(api.login);
    elements.settingsSignIn.onclick = () => void invoke(api.login);
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
    onboarding: byId("desktopAccountOnboarding"),
    onboardingChannel: byId("desktopAccountOnboardingChannel"),
    onboardingStatus: byId("desktopAccountOnboardingStatus"),
    onboardingSignIn: byId("desktopAccountOnboardingSignIn"),
    onboardingNotNow: byId("desktopAccountOnboardingNotNow"),
    settingsStatus: byId("desktopAccountStatus"),
    settingsDetail: byId("desktopAccountDetail"),
    settingsChannel: byId("desktopAccountChannel"),
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

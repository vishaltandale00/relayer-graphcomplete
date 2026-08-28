import { ModelCatalogAdapter, sanitizeModelCatalogSnapshot } from "../../models/model-catalog-adapter.mjs";
import { CredentialAdapter } from "../../credentials/credential-adapter.mjs";

export class ManagedRuntimeCredentialAdapter extends CredentialAdapter {
  constructor({ definition, runtimeFactory }) {
    super(definition.id);
    if (typeof runtimeFactory !== "function") throw new Error(`${definition.adapterId} requires a managed runtime factory.`);
    this.definition = definition;
    this.runtimeFactory = runtimeFactory;
    this.runtime = null;
  }

  async #getRuntime() {
    this.runtime ??= await this.runtimeFactory(this.definition);
    return this.runtime;
  }

  async account(options) { return (await this.#getRuntime()).account(options); }
  async login(options) { return (await this.#getRuntime()).login(options); }
  async logout(options) { return (await this.#getRuntime()).logout(options); }
  async request(method, params, timeout, signal) {
    return (await this.#getRuntime()).request(method, params, timeout, signal);
  }
  async close() {
    const runtime = this.runtime;
    this.runtime = null;
    await runtime?.close?.();
  }
}

export class PrimeProfileCredentialAdapter extends CredentialAdapter {
  constructor({ definition, profile, environment, fallbackRuntimeFactory }) {
    super(definition.id);
    if (!profile) throw new Error(`${definition.adapterId} requires a Prime subscription profile.`);
    this.definition = definition;
    this.profile = profile;
    this.runtime = Object.freeze({ environment: Object.freeze({ ...(environment ?? {}) }) });
    this.fallbackRuntimeFactory = fallbackRuntimeFactory;
    this.fallbackRuntime = null;
    this.fallbackUsed = false;
  }

  async account(options) {
    let account;
    try {
      account = await this.profile.account(this.definition.id, options);
    } catch {
      account = { status: "unavailable", account: null };
    }
    if (account?.status === "connected" || typeof this.fallbackRuntimeFactory !== "function") return account;
    this.fallbackRuntime ??= await this.fallbackRuntimeFactory(this.definition);
    const fallback = await this.fallbackRuntime.account(options);
    this.fallbackUsed ||= fallback?.status === "connected";
    return fallback;
  }
  async login(options) { return this.profile.login(this.definition, options); }
  async logout(options) {
    const account = await this.profile.logout(this.definition.id, options);
    if (this.fallbackUsed) await this.fallbackRuntime?.logout?.(options);
    this.fallbackUsed = false;
    return account;
  }
  async nativeRequestAccess(options) {
    return this.profile.nativeRequestAccess(this.definition.id, this.definition.adapterId, options);
  }
  async close() {
    const fallback = this.fallbackRuntime;
    this.fallbackRuntime = null;
    await fallback?.close?.();
  }
}

export class ManagedRuntimeModelCatalogAdapter extends ModelCatalogAdapter {
  constructor({ definition, credentials, discoverModels }) {
    super({ providerId: definition.id, providerLabel: definition.label });
    if (typeof discoverModels !== "function") throw new Error("Managed subscription catalog requires discoverModels().");
    this.credentials = credentials;
    this.discoverModels = discoverModels;
  }

  async discover({ signal } = {}) {
    const account = await this.credentials.account({ signal });
    if (account?.status !== "connected") {
      return sanitizeModelCatalogSnapshot({
        provider: {
          id: this.providerId,
          label: this.providerLabel,
          status: account?.status === "unavailable" ? "unavailable" : "disconnected",
          unavailableReason: account?.status === "unavailable" ? "Subscription runtime is unavailable." : null,
        },
        models: [],
        systemFamily: { id: this.providerId, label: this.providerLabel, modelIds: [] },
      });
    }
    const values = await this.discoverModels({ credentials: this.credentials, signal });
    if (!Array.isArray(values)) throw new Error("Managed subscription returned a malformed model catalog.");
    const models = values.map((value) => ({
      id: value.id,
      catalogId: value.catalogId ?? value.id,
      executionModel: value.executionModel ?? value.id,
      label: value.label ?? value.id,
      description: value.description ?? "",
      visible: value.visible !== false,
      availability: value.available === false ? "unavailable" : "available",
      unavailableReason: value.available === false ? value.unavailableReason || "Model is unavailable." : null,
      availabilityNotice: null,
      isDefault: value.providerDefault === true,
      replacementModelId: null,
      upgradeInfo: null,
      supportedEfforts: [],
      defaultEffort: null,
      inputModalities: value.inputModalities ?? ["text"],
      supportsPersonality: false,
      serviceTiers: [],
      defaultServiceTier: null,
      catalogSource: value.catalogSource ?? null,
    }));
    return sanitizeModelCatalogSnapshot({
      provider: { id: this.providerId, label: this.providerLabel, status: "available", unavailableReason: null },
      models,
      systemFamily: { id: this.providerId, label: this.providerLabel, modelIds: [] },
    });
  }
}

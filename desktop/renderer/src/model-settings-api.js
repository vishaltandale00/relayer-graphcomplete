import { request } from "./api.js";

export function loadModelSettings() {
  return request("/api/model-settings");
}

export function saveModelDefaults(defaults) {
  return request("/api/model-settings/defaults", {
    method: "PUT",
    body: JSON.stringify(defaults),
  });
}

export function validateModelSelection(selection) {
  return request("/api/model-selection/validate", {
    method: "POST",
    body: JSON.stringify(selection),
  });
}

export function loadDefaultModelSelection(harnessId) {
  return request(`/api/model-selection/default?harnessId=${encodeURIComponent(harnessId)}`);
}

export function loadProviderOnboardingProjection(providerId) {
  return request(`/api/provider-onboarding/projection?providerId=${encodeURIComponent(providerId)}`);
}

export function completeProviderOnboarding(intent) {
  return request("/api/provider-onboarding/complete", {
    method: "POST",
    body: JSON.stringify(intent),
  });
}

export function loadProviderOnboardingStatus() {
  return request("/api/provider-onboarding/status");
}

export function createModelFamily(family) {
  return request("/api/model-families", {
    method: "POST",
    body: JSON.stringify(family),
  });
}

export function updateModelFamily(familyId, family) {
  return request(`/api/model-families/${encodeURIComponent(familyId)}`, {
    method: "PUT",
    body: JSON.stringify(family),
  });
}

export function deleteModelFamily(familyId) {
  return request(`/api/model-families/${encodeURIComponent(familyId)}`, { method: "DELETE" });
}

export function saveModelFamilyOrder(familyIds) {
  return request("/api/model-families/order", {
    method: "PUT",
    body: JSON.stringify({ familyIds }),
  });
}

export function saveHarnessModelRules(harnessId, payload) {
  return request(`/api/harness-configurations/${encodeURIComponent(harnessId)}/model-rules`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

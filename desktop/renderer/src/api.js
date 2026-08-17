import { query } from "./state.js";

const API_BASE = (query.get("api") || window.GRAPHCOMPLETE_CONFIG?.apiBase || "").replace(/\/$/, "");

export const apiUrl = (path) => `${API_BASE}${path}`;

export async function request(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed (${response.status})`);
    error.code = body?.code;
    error.details = body;
    error.status = response.status;
    throw error;
  }
  return body;
}

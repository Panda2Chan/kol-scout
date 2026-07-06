import { BACKEND_CONFIG } from "./generated-config.js";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";

export function getBackendApiBaseUrl() {
  return String(BACKEND_CONFIG.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

export function buildBackendHeaders(headers = {}) {
  const nextHeaders = { ...headers };
  const token = String(BACKEND_CONFIG.authToken || "").trim();
  if (token) nextHeaders.Authorization = `Bearer ${token}`;
  return nextHeaders;
}

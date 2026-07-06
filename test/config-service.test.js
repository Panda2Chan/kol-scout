import test from "node:test";
import assert from "node:assert/strict";
import {
  ConfigError,
  getBackendConfig,
  getExtensionBuildConfig,
  getHealthConfigSummary
} from "../backend/services/config-service.js";

test("backend config keeps local development restrictions disabled by default", () => {
  const config = getBackendConfig({});

  assert.equal(config.appEnv, "development");
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.server.port, 8787);
  assert.equal(config.auth.required, false);
  assert.equal(config.limits.enabled, false);
  assert.equal(config.queue.limitsEnabled, false);
  assert.equal(config.limits.userDailyDiscoveryQuota, 0);
  assert.equal(config.limits.userConcurrentDiscoveryLimit, 0);
});

test("backend config enables public protections by default in production", () => {
  const config = getBackendConfig({
    APP_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "9000",
    CACHE_DRIVER: "redis",
    REDIS_URL: "redis://localhost:6379"
  });

  assert.equal(config.appEnv, "production");
  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.server.port, 9000);
  assert.equal(config.auth.required, true);
  assert.equal(config.limits.enabled, true);
  assert.equal(config.queue.limitsEnabled, true);
  assert.equal(config.cache.redisRequired, true);
});

test("extension production build requires HTTPS API base URL", () => {
  assert.throws(
    () => getExtensionBuildConfig({ KOL_API_BASE_URL: "http://api.example.com" }, { target: "production" }),
    ConfigError
  );

  const config = getExtensionBuildConfig({
    KOL_API_BASE_URL: "https://api.example.com/v1/"
  }, { target: "production" });

  assert.equal(config.apiBaseUrl, "https://api.example.com/v1");
  assert.deepEqual(config.hostPermissions, ["https://api.example.com/*"]);
});

test("health summary exposes safe deployment metadata", () => {
  const summary = getHealthConfigSummary(getBackendConfig({
    APP_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "8787",
    CACHE_DRIVER: "redis",
    REDIS_URL: "redis://:secret@example.com:6379",
    API_AUTH_TOKEN: "secret-token"
  }));

  assert.equal(summary.env, "production");
  assert.equal(summary.server.host, "0.0.0.0");
  assert.equal(summary.cache.driver, "redis");
  assert.equal(summary.cache.redisConfigured, true);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

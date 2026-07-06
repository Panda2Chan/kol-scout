import test from "node:test";
import assert from "node:assert/strict";
import { createAccessController } from "../backend/services/access-control-service.js";
import { getBackendConfig } from "../backend/services/config-service.js";
import { formatBackendErrorMessage } from "../src/shared/backend-errors.js";

test("access control bypasses auth and limits by default in local development", async () => {
  const controller = createAccessController(getBackendConfig({}));
  const access = await controller.guardRequest(createRequest(), { discovery: true });

  assert.equal(access.identity.id, "local-dev");
  assert.equal(access.identity.bypassed, true);
  await access.release();
});

test("access control rejects missing and invalid bearer tokens when auth is enabled", async () => {
  const controller = createAccessController(getBackendConfig({
    APP_ENV: "production",
    ACCESS_LIMITS_ENABLED: "false",
    API_AUTH_TOKEN: "valid-token"
  }));

  await assert.rejects(
    controller.guardRequest(createRequest()),
    (error) => error.code === "AUTH_TOKEN_MISSING" && error.statusCode === 401
  );
  await assert.rejects(
    controller.guardRequest(createRequest({ authorization: "Bearer bad-token" })),
    (error) => error.code === "AUTH_TOKEN_INVALID" && error.statusCode === 403
  );
});

test("access control resolves valid bearer token identity", async () => {
  const controller = createAccessController(getBackendConfig({
    APP_ENV: "production",
    ACCESS_LIMITS_ENABLED: "false",
    API_AUTH_TOKEN: "valid-token"
  }));
  const access = await controller.guardRequest(createRequest({ authorization: "Bearer valid-token" }));

  assert.equal(access.identity.authenticated, true);
  assert.equal(access.identity.id.startsWith("token:"), true);
});

test("access control enforces IP request window", async () => {
  const controller = createAccessController(getBackendConfig({
    APP_ENV: "production",
    API_AUTH_TOKEN: "valid-token",
    IP_RATE_LIMIT_WINDOW_MS: "1000",
    IP_RATE_LIMIT_MAX_REQUESTS: "1"
  }), { now: () => 1_000 });
  const req = createRequest({ authorization: "Bearer valid-token", "x-forwarded-for": "203.0.113.10" });

  await controller.guardRequest(req);
  await assert.rejects(
    controller.guardRequest(req),
    (error) => error.code === "RATE_LIMITED" && error.statusCode === 429
  );
});

test("access control enforces daily discovery quota", async () => {
  const controller = createAccessController(getBackendConfig({
    APP_ENV: "production",
    API_AUTH_TOKEN: "valid-token",
    USER_DAILY_DISCOVERY_QUOTA: "1",
    USER_CONCURRENT_DISCOVERY_LIMIT: "0"
  }), { now: () => Date.UTC(2026, 6, 4) });
  const req = createRequest({ authorization: "Bearer valid-token" });

  await (await controller.guardRequest(req, { discovery: true })).release();
  await assert.rejects(
    controller.guardRequest(req, { discovery: true }),
    (error) => error.code === "DAILY_QUOTA_EXCEEDED" && error.statusCode === 429
  );
});

test("access control releases user concurrency slots", async () => {
  const controller = createAccessController(getBackendConfig({
    APP_ENV: "production",
    API_AUTH_TOKEN: "valid-token",
    USER_DAILY_DISCOVERY_QUOTA: "0",
    USER_CONCURRENT_DISCOVERY_LIMIT: "1"
  }));
  const req = createRequest({ authorization: "Bearer valid-token" });

  const first = await controller.guardRequest(req, { discovery: true });
  await assert.rejects(
    controller.guardRequest(req, { discovery: true }),
    (error) => error.code === "USER_CONCURRENCY_LIMITED" && error.statusCode === 429
  );
  await first.release();
  await (await controller.guardRequest(req, { discovery: true })).release();
});

test("frontend backend error mapping returns concise Chinese messages", () => {
  assert.equal(formatBackendErrorMessage({ code: "RATE_LIMITED" }), "请求太频繁，稍后再试。");
  assert.equal(formatBackendErrorMessage({ error: "原始错误" }), "原始错误");
});

function createRequest(headers = {}) {
  return {
    headers,
    socket: {
      remoteAddress: "127.0.0.1"
    }
  };
}

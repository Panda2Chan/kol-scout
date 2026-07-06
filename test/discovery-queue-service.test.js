import test from "node:test";
import assert from "node:assert/strict";
import { createDiscoveryQueue } from "../backend/services/discovery-queue-service.js";
import { getBackendConfig } from "../backend/services/config-service.js";

test("discovery queue bypasses capacity limits in local development but emits lifecycle callbacks", async () => {
  const queue = createDiscoveryQueue(getBackendConfig({}));
  const events = [];
  const result = await queue.run(() => Promise.resolve("ok"), {
    onQueued: (event) => events.push(["queued", event.position]),
    onStarted: (event) => events.push(["started", event.running])
  });

  assert.equal(result, "ok");
  assert.deepEqual(events, [["queued", 0], ["started", 1]]);
});

test("discovery queue limits concurrency and starts queued work after release", async () => {
  const queue = createDiscoveryQueue(queueConfig({ maxConcurrent: 1, maxSize: 2 }));
  const firstDeferred = createDeferred();
  const started = [];

  const first = queue.run(() => firstDeferred.promise, {
    onStarted: () => started.push("first")
  });
  const second = queue.run(() => Promise.resolve("second"), {
    onStarted: () => started.push("second")
  });

  assert.deepEqual(started, ["first"]);
  assert.deepEqual(queue.getState(), { running: 1, queued: 1, limitsEnabled: true });

  firstDeferred.resolve("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(queue.getState().running, 0);
});

test("discovery queue rejects when queue capacity is full", () => {
  const queue = createDiscoveryQueue(queueConfig({ maxConcurrent: 1, maxSize: 1 }));
  const firstDeferred = createDeferred();
  queue.run(() => firstDeferred.promise);
  queue.run(() => Promise.resolve("queued"));

  assert.throws(
    () => queue.run(() => Promise.resolve("overflow")),
    (error) => error.code === "DISCOVERY_QUEUE_FULL" && error.statusCode === 429
  );

  firstDeferred.resolve("done");
});

test("discovery queue rejects queued work after wait timeout", async () => {
  const timers = [];
  const queue = createDiscoveryQueue(queueConfig({ maxConcurrent: 1, maxSize: 2, timeoutMs: 100 }), {
    setTimeout: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeout: () => {}
  });
  const firstDeferred = createDeferred();
  queue.run(() => firstDeferred.promise);
  const queued = queue.run(() => Promise.resolve("late"));

  timers.at(-1)();
  await assert.rejects(queued, (error) => error.code === "DISCOVERY_QUEUE_TIMEOUT");
  firstDeferred.resolve("done");
});

test("discovery queue cancels queued work when the signal aborts before start", async () => {
  const queue = createDiscoveryQueue(queueConfig({ maxConcurrent: 1, maxSize: 2 }));
  const firstDeferred = createDeferred();
  const controller = new AbortController();
  queue.run(() => firstDeferred.promise);
  const queued = queue.run(() => Promise.resolve("late"), { signal: controller.signal });

  controller.abort();
  await assert.rejects(queued, (error) => error.code === "DISCOVERY_QUEUE_CANCELLED");
  assert.equal(queue.getState().queued, 0);
  firstDeferred.resolve("done");
});

function queueConfig({ maxConcurrent = 1, maxSize = 2, timeoutMs = 1_000 } = {}) {
  return getBackendConfig({
    APP_ENV: "production",
    DISCOVERY_MAX_CONCURRENT: String(maxConcurrent),
    DISCOVERY_QUEUE_MAX_SIZE: String(maxSize),
    DISCOVERY_QUEUE_TIMEOUT_MS: String(timeoutMs)
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

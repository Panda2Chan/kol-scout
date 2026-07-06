export class DiscoveryQueueError extends Error {
  constructor(message, code, statusCode = 503) {
    super(message);
    this.name = "DiscoveryQueueError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createDiscoveryQueue(config, options = {}) {
  const now = options.now || (() => Date.now());
  const setTimer = options.setTimeout || globalThis.setTimeout;
  const clearTimer = options.clearTimeout || globalThis.clearTimeout;
  const state = {
    running: 0,
    pending: []
  };

  return {
    getState() {
      return {
        running: state.running,
        queued: state.pending.length,
        limitsEnabled: config.queue.limitsEnabled
      };
    },
    run(task, runOptions = {}) {
      if (!config.queue.limitsEnabled) {
        runOptions.onQueued?.({ position: 0, queued: 0, running: state.running, waitMs: 0 });
        runOptions.onStarted?.({ queued: 0, running: state.running + 1, waitMs: 0 });
        return task();
      }

      if (state.pending.length >= config.queue.maxSize) {
        throw new DiscoveryQueueError("全站匹配排队已满，请稍后再试。", "DISCOVERY_QUEUE_FULL", 429);
      }

      return new Promise((resolve, reject) => {
        const job = {
          task,
          resolve,
          reject,
          enqueuedAt: now(),
          signal: runOptions.signal,
          onQueued: runOptions.onQueued,
          onStarted: runOptions.onStarted,
          timer: null,
          abortHandler: null,
          started: false
        };

        if (job.signal?.aborted) {
          rejectQueueAbort(job);
          return;
        }

        job.abortHandler = () => cancelQueuedJob(job);
        job.signal?.addEventListener?.("abort", job.abortHandler, { once: true });
        job.timer = setTimer(() => {
          removePendingJob(job);
          cleanupJob(job);
          job.reject(new DiscoveryQueueError("全站匹配排队超时，请稍后再试。", "DISCOVERY_QUEUE_TIMEOUT", 429));
        }, config.queue.timeoutMs);

        state.pending.push(job);
        job.onQueued?.({
          position: state.pending.length,
          queued: state.pending.length,
          running: state.running,
          waitMs: 0
        });
        drainQueue();
      });
    }
  };

  function drainQueue() {
    while (state.running < config.queue.maxConcurrent && state.pending.length) {
      const job = state.pending.shift();
      startJob(job);
    }
  }

  async function startJob(job) {
    job.started = true;
    cleanupJob(job);
    state.running += 1;
    job.onStarted?.({
      queued: state.pending.length,
      running: state.running,
      waitMs: Math.max(0, now() - job.enqueuedAt)
    });

    try {
      job.resolve(await job.task());
    } catch (error) {
      job.reject(error);
    } finally {
      state.running = Math.max(0, state.running - 1);
      drainQueue();
    }
  }

  function cancelQueuedJob(job) {
    if (job.started) return;
    removePendingJob(job);
    cleanupJob(job);
    rejectQueueAbort(job);
  }

  function rejectQueueAbort(job) {
    job.reject?.(new DiscoveryQueueError("全站匹配排队已取消。", "DISCOVERY_QUEUE_CANCELLED", 499));
  }

  function removePendingJob(job) {
    const index = state.pending.indexOf(job);
    if (index >= 0) state.pending.splice(index, 1);
  }

  function cleanupJob(job) {
    if (job.timer) clearTimer(job.timer);
    job.timer = null;
    if (job.abortHandler) job.signal?.removeEventListener?.("abort", job.abortHandler);
    job.abortHandler = null;
  }
}

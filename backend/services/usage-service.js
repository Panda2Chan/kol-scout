import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

const STAGE_COUNTERS = {
  ai_plan: "aiPlanCalls",
  ai_web_search: "aiWebSearchCalls",
  provider_discovery: "searchProviderCalls",
  profile_enrich: "enrichProfileCalls",
  ai_review: "aiReviewCalls"
};

export function createUsageService(config, options = {}) {
  const now = options.now || (() => Date.now());
  const records = options.records || [];
  const sink = options.sink || createUsageSink(config);

  return {
    records,
    createContext(input = {}) {
      return createUsageContext(input, { now, records, sink });
    },
    summarizeDailyUsage(input = {}) {
      return summarizeDailyUsage(records, input);
    }
  };
}

export function createUsageContext(input = {}, options = {}) {
  const now = options.now || (() => Date.now());
  const records = options.records || [];
  const sink = options.sink || { write: async () => {} };
  const startedAt = now();
  const counters = {
    aiPlanCalls: 0,
    aiWebSearchCalls: 0,
    aiReviewCalls: 0,
    searchProviderCalls: 0,
    enrichProfileCalls: 0
  };
  const durations = {};
  let flushed = false;

  return {
    requestId: input.requestId || "",
    identityId: input.identity?.id || "anonymous",
    tokenId: input.identity?.tokenId || "",
    recordStage(stage, stageStartedAt = startedAt, metadata = {}) {
      const counterName = STAGE_COUNTERS[stage];
      if (counterName) counters[counterName] += 1;
      durations[`${stage}Ms`] = (durations[`${stage}Ms`] || 0) + Math.max(0, now() - Number(stageStartedAt || now()));
      return metadata;
    },
    async finish(result = {}) {
      if (flushed) return null;
      flushed = true;
      const finishedAt = now();
      const record = sanitizeUsageRecord({
        requestId: input.requestId || "",
        identityId: input.identity?.id || "anonymous",
        tokenId: input.identity?.tokenId || "",
        platform: input.platform || "",
        briefLength: getBriefLength(input.brief),
        requestedLimit: Number(input.requestedLimit || 0),
        status: result.status || "unknown",
        errorCode: result.error?.code || "",
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        totalElapsedMs: Math.max(0, finishedAt - startedAt),
        candidatesReturned: result.response?.candidates?.length || 0,
        estimatedCost: null,
        ...counters,
        ...durations
      });
      records.push(record);
      await sink.write(record);
      return record;
    }
  };
}

export function summarizeDailyUsage(records = [], input = {}) {
  const day = input.day || new Date().toISOString().slice(0, 10);
  const identityId = input.identityId || "";
  const platform = input.platform || "";
  const matched = records.filter((record) =>
    String(record.startedAt || "").startsWith(day) &&
    (!identityId || record.identityId === identityId) &&
    (!platform || record.platform === platform)
  );

  return matched.reduce((summary, record) => {
    summary.requests += 1;
    summary.totalElapsedMs += Number(record.totalElapsedMs || 0);
    summary.candidatesReturned += Number(record.candidatesReturned || 0);
    summary.aiPlanCalls += Number(record.aiPlanCalls || 0);
    summary.aiWebSearchCalls += Number(record.aiWebSearchCalls || 0);
    summary.aiReviewCalls += Number(record.aiReviewCalls || 0);
    summary.searchProviderCalls += Number(record.searchProviderCalls || 0);
    summary.enrichProfileCalls += Number(record.enrichProfileCalls || 0);
    return summary;
  }, {
    day,
    identityId,
    platform,
    requests: 0,
    totalElapsedMs: 0,
    candidatesReturned: 0,
    aiPlanCalls: 0,
    aiWebSearchCalls: 0,
    aiReviewCalls: 0,
    searchProviderCalls: 0,
    enrichProfileCalls: 0,
    estimatedCost: null
  });
}

function createUsageSink(config) {
  if (config.usage.sink === "none") return { write: async () => {} };
  if (config.usage.sink === "jsonl") {
    return {
      async write(record) {
        await mkdir(dirname(config.usage.jsonlPath), { recursive: true });
        await appendFile(config.usage.jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
      }
    };
  }

  return {
    async write() {
      // Redis-backed usage writes are wired in the distributed-cache milestone.
    }
  };
}

function sanitizeUsageRecord(record = {}) {
  const copy = { ...record };
  delete copy.token;
  delete copy.authorization;
  delete copy.apiKey;
  delete copy.prompt;
  delete copy.brief;
  return copy;
}

function getBriefLength(brief = {}) {
  return String(brief.rawText || brief.query || brief.text || "").length;
}

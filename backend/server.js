import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./services/env-service.js";
import { discoverCreators } from "./services/discovery-service.js";
import { buildCreatorSearchPlan, matchCreators } from "./services/match-service.js";
import { buildAiCreatorSearchPlan, configureAiSearchCache } from "./services/ai-search-service.js";
import { getBackendConfig, getCorsHeaders, getHealthConfigSummary } from "./services/config-service.js";
import { createAccessController } from "./services/access-control-service.js";
import { createDiscoveryQueue } from "./services/discovery-queue-service.js";
import { createUsageService } from "./services/usage-service.js";
import { createCacheAdapter } from "./services/cache-service.js";
import { configureDiscoveryCache } from "./services/discovery-cache-service.js";
import { createRequestLogger } from "./services/logger-service.js";
import { createPlatformRegistry } from "./platforms/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadLocalEnv(resolve(__dirname, "..", ".env"));

const config = getBackendConfig();
const cacheAdapter = createCacheAdapter(config);
if (config.cache.redisRequired) {
  await cacheAdapter.health();
}
configureDiscoveryCache({ cacheAdapter });
configureAiSearchCache({ cacheAdapter, ttlMs: config.cache.aiPlanTtlMs });
const accessController = createAccessController(config, { cacheAdapter });
const discoveryQueue = createDiscoveryQueue(config);
const usageService = createUsageService(config);
const registry = createPlatformRegistry();

const server = createServer(async (req, res) => {
  let requestLogger = null;
  try {
    if (req.method === "OPTIONS") {
      return sendJson(req, res, 204, {});
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const health = getHealthConfigSummary(config);
      const cacheHealth = await cacheAdapter.health().catch((error) => ({
        driver: config.cache.driver,
        available: false,
        error: error.message
      }));
      return sendJson(req, res, 200, {
        ok: true,
        service: "kol-lite-api",
        ...health,
        cache: {
          ...health.cache,
          ...cacheHealth
        },
        searchProviders: {
          tavily: Boolean(process.env.TAVILY_API_KEY),
          jina: Boolean(process.env.JINA_API_KEY),
          serper: Boolean(process.env.SERPER_API_KEY),
          brave: Boolean(process.env.BRAVE_SEARCH_API_KEY)
        }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/match/creators") {
      await accessController.guardRequest(req);
      const body = await readJson(req);
      const creators = Array.isArray(body.creators) ? body.creators : [];
      return sendJson(req, res, 200, {
        results: matchCreators(body.brief || {}, creators, { locale: body.locale || "zh-CN" })
      });
    }

    if (req.method === "POST" && url.pathname === "/api/search/creators") {
      await accessController.guardRequest(req);
      const body = await readJson(req);
      const fallbackPlan = buildCreatorSearchPlan(body.brief || {}, {
        platform: body.platform || "tiktok",
        locale: body.locale || "zh-CN"
      });
      const plan = await buildAiCreatorSearchPlan(fallbackPlan.normalizedBrief, fallbackPlan, {
        platform: body.platform || "tiktok",
        locale: body.locale || "zh-CN"
      });
      const provider = registry.get(plan.platform);

      if (!provider?.buildSearchUrl) {
        return sendJson(req, res, 400, { ok: false, error: `Unsupported search platform: ${plan.platform}` });
      }

      const directProfileUrls = plan.directProfiles
        .map((handle) => provider.buildProfileUrl?.(handle))
        .filter(Boolean);

      return sendJson(req, res, 200, {
        ok: true,
        plan: {
          ...plan,
          searchUrl: provider.buildSearchUrl(plan),
          directProfileUrls,
          actions: [
            {
              type: "open_search",
              label: `打开 ${platformLabel(plan.platform)} 全站用户搜索`,
              query: plan.query,
              url: provider.buildSearchUrl(plan)
            },
            ...directProfileUrls.map((profileUrl) => ({
              type: "open_profile",
              label: "打开指定 OP 主页",
              url: profileUrl
            }))
          ]
        }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/discover/creators/stream") {
      let access = null;
      let usage = null;
      requestLogger = createRequestLogger("discover-api", {
        method: req.method,
        route: url.pathname
      });
      const controller = new AbortController();
      req.on("aborted", () => {
        requestLogger?.warn("request.client_aborted");
        controller.abort(new Error("client aborted"));
      });
      res.on("close", () => {
        if (!res.writableEnded) {
          requestLogger?.warn("response.closed_before_end", {
            writableEnded: res.writableEnded
          });
          controller.abort(new Error("response closed"));
        }
      });

      access = await accessController.guardRequest(req, { discovery: true });
      try {
        const body = await readJson(req);
        const platform = body.platform || "tiktok";
        usage = usageService.createContext({
          requestId: requestLogger.requestId,
          identity: access.identity,
          platform,
          brief: body.brief || {},
          requestedLimit: body.limit || 20
        });
        requestLogger.info("request.stream_start", {
          platform,
          limit: body.limit || 20,
          briefLength: getBriefLength(body.brief),
          filters: summarizeFilters(body.filters || {}),
          feedbackItems: Array.isArray(body.feedback?.items) ? body.feedback.items.length : 0,
          searchProviders: getSearchProviderStatus()
        });

        sendJsonStreamHeaders(req, res);
        writeStreamEvent(res, "start", {
          ok: true,
          requestId: requestLogger.requestId,
          platform
        });

        const result = await discoveryQueue.run(() => discoverCreators(body.brief || {}, registry, {
            platform,
            locale: body.locale || "zh-CN",
            limit: body.limit || 20,
            filters: body.filters || {},
            feedback: body.feedback || {},
            signal: controller.signal,
            logger: requestLogger.child({ component: "discovery-service" }),
            usage,
            onCandidate: (candidate, progress) => {
              writeStreamEvent(res, "candidate", {
                requestId: requestLogger.requestId,
                candidate,
                progress
              });
            }
          }), {
          signal: controller.signal,
          onQueued: (queue) => {
            writeStreamEvent(res, "queued", {
              requestId: requestLogger.requestId,
              queue
            });
          },
          onStarted: (queue) => {
            writeStreamEvent(res, "started", {
              requestId: requestLogger.requestId,
              queue
            });
          }
        });

        await usage.finish({ status: "success", response: result });
        requestLogger.info("request.stream_success", {
          statusCode: 200,
          candidates: result.candidates?.length || 0,
          totalFetched: result.summary?.totalFetched || 0,
          rawFetched: result.summary?.rawFetched || 0,
          dataSource: result.summary?.dataSource || "",
          aiReviewEnabled: Boolean(result.summary?.aiReview?.enabled)
        });
        writeStreamEvent(res, "complete", { ok: true, requestId: requestLogger.requestId, ...result });
        return res.end();
      } catch (error) {
        await usage?.finish({ status: "error", error });
        const statusCode = error.statusCode || 500;
        requestLogger?.[error.code === "DISCOVERY_EMPTY" ? "warn" : "error"]?.("request.stream_error", {
          statusCode,
          code: error.code || "INTERNAL_ERROR",
          error
        });
        writeStreamEvent(res, "error", {
          ok: false,
          requestId: requestLogger.requestId,
          error: error.message,
          code: error.code || "INTERNAL_ERROR",
          statusCode
        });
        return res.end();
      } finally {
        await access?.release();
      }
    }

    if (req.method === "POST" && url.pathname === "/api/discover/creators") {
      let access = null;
      let usage = null;
      requestLogger = createRequestLogger("discover-api", {
        method: req.method,
        route: url.pathname
      });
      req.on("aborted", () => {
        requestLogger?.warn("request.client_aborted");
      });
      res.on("close", () => {
        if (!res.writableEnded) {
          requestLogger?.warn("response.closed_before_end", {
            writableEnded: res.writableEnded
          });
        }
      });

      try {
        access = await accessController.guardRequest(req, { discovery: true });
        const body = await readJson(req);
        const platform = body.platform || "tiktok";
        usage = usageService.createContext({
          requestId: requestLogger.requestId,
          identity: access.identity,
          platform,
          brief: body.brief || {},
          requestedLimit: body.limit || 20
        });
        requestLogger.info("request.start", {
          platform,
          limit: body.limit || 20,
          briefLength: getBriefLength(body.brief),
          filters: summarizeFilters(body.filters || {}),
          feedbackItems: Array.isArray(body.feedback?.items) ? body.feedback.items.length : 0,
          searchProviders: getSearchProviderStatus()
        });

        const result = await discoveryQueue.run(() => discoverCreators(body.brief || {}, registry, {
          platform,
          locale: body.locale || "zh-CN",
          limit: body.limit || 20,
          filters: body.filters || {},
          feedback: body.feedback || {},
          logger: requestLogger.child({ component: "discovery-service" }),
          usage
        }));

        await usage.finish({ status: "success", response: result });
        requestLogger.info("request.success", {
          statusCode: 200,
          candidates: result.candidates?.length || 0,
          totalFetched: result.summary?.totalFetched || 0,
          rawFetched: result.summary?.rawFetched || 0,
          dataSource: result.summary?.dataSource || "",
          aiReviewEnabled: Boolean(result.summary?.aiReview?.enabled)
        });
        return sendJson(req, res, 200, { ok: true, requestId: requestLogger.requestId, ...result });
      } catch (error) {
        await usage?.finish({ status: "error", error });
        throw error;
      } finally {
        await access?.release();
      }
    }

    return sendJson(req, res, 404, { ok: false, error: "Route not found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const isEmptyResult = error.code === "DISCOVERY_EMPTY";
    requestLogger?.[isEmptyResult ? "warn" : "error"]?.(isEmptyResult ? "request.empty" : "request.error", {
      statusCode,
      code: error.code || "INTERNAL_ERROR",
      error
    });
    if (res.headersSent) {
      writeStreamEvent(res, "error", {
        ok: false,
        requestId: requestLogger?.requestId,
        error: error.message,
        code: error.code || "INTERNAL_ERROR",
        statusCode
      });
      return res.end();
    }
    return sendJson(req, res, statusCode, {
      ok: false,
      requestId: requestLogger?.requestId,
      error: error.message,
      code: error.code || "INTERNAL_ERROR"
    });
  }
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`KOL Scout API listening on http://${config.server.host}:${config.server.port}`);
});

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(req, res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...getCorsHeaders(req, config)
  });

  if (statusCode === 204) {
    res.end();
    return;
  }

  res.end(JSON.stringify(payload));
}

function sendJsonStreamHeaders(req, res) {
  res.writeHead(200, {
    ...getCorsHeaders(req, config),
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();
}

function writeStreamEvent(res, event, payload = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`${JSON.stringify({ event, ...payload })}\n`);
}

function getSearchProviderStatus() {
  return {
    tavily: Boolean(process.env.TAVILY_API_KEY),
    jina: Boolean(process.env.JINA_API_KEY),
    serper: Boolean(process.env.SERPER_API_KEY),
    brave: Boolean(process.env.BRAVE_SEARCH_API_KEY),
    thirdPartyKolData: Boolean(process.env.KOL_DATA_API_URL)
  };
}

function getBriefLength(brief = {}) {
  return String(brief.rawText || brief.query || brief.text || "").length;
}

function summarizeFilters(filters = {}) {
  return {
    minMatchScore: filters.minMatchScore ?? null,
    minQualityScore: filters.minQualityScore ?? null,
    minFollowers: filters.minFollowers ?? null,
    country: filters.country || "",
    maxFakeFollowerRisk: filters.maxFakeFollowerRisk || ""
  };
}

function platformLabel(platform) {
  return {
    x: "X",
    tiktok: "TikTok"
  }[platform] || String(platform || "目标平台");
}

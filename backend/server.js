import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./services/env-service.js";
import { discoverCreators } from "./services/discovery-service.js";
import { buildCreatorSearchPlan, matchCreators } from "./services/match-service.js";
import { buildAiCreatorSearchPlan } from "./services/ai-search-service.js";
import { createRequestLogger } from "./services/logger-service.js";
import { createPlatformRegistry } from "./platforms/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadLocalEnv(resolve(__dirname, "..", ".env"));

const PORT = Number(process.env.PORT || 8787);
const registry = createPlatformRegistry();

const server = createServer(async (req, res) => {
  let requestLogger = null;
  try {
    if (req.method === "OPTIONS") {
      return sendJson(res, 204, {});
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "kol-lite-api",
        searchProviders: {
          tavily: Boolean(process.env.TAVILY_API_KEY),
          jina: Boolean(process.env.JINA_API_KEY),
          serper: Boolean(process.env.SERPER_API_KEY),
          brave: Boolean(process.env.BRAVE_SEARCH_API_KEY)
        }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/match/creators") {
      const body = await readJson(req);
      const creators = Array.isArray(body.creators) ? body.creators : [];
      return sendJson(res, 200, {
        results: matchCreators(body.brief || {}, creators, { locale: body.locale || "zh-CN" })
      });
    }

    if (req.method === "POST" && url.pathname === "/api/search/creators") {
      const body = await readJson(req);
      const fallbackPlan = buildCreatorSearchPlan(body.brief || {}, {
        platform: body.platform || "x",
        locale: body.locale || "zh-CN"
      });
      const plan = await buildAiCreatorSearchPlan(fallbackPlan.normalizedBrief, fallbackPlan, {
        platform: body.platform || "x",
        locale: body.locale || "zh-CN"
      });
      const provider = registry.get(plan.platform);

      if (!provider?.buildSearchUrl) {
        return sendJson(res, 400, { ok: false, error: `Unsupported search platform: ${plan.platform}` });
      }

      const directProfileUrls = plan.directProfiles
        .map((handle) => provider.buildProfileUrl?.(handle))
        .filter(Boolean);

      return sendJson(res, 200, {
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

    if (req.method === "POST" && url.pathname === "/api/discover/creators") {
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

      const body = await readJson(req);
      const platform = body.platform || "x";
      requestLogger.info("request.start", {
        platform,
        limit: body.limit || 20,
        briefLength: getBriefLength(body.brief),
        filters: summarizeFilters(body.filters || {}),
        feedbackItems: Array.isArray(body.feedback?.items) ? body.feedback.items.length : 0,
        searchProviders: getSearchProviderStatus()
      });

      const result = await discoverCreators(body.brief || {}, registry, {
        platform,
        locale: body.locale || "zh-CN",
        limit: body.limit || 20,
        filters: body.filters || {},
        feedback: body.feedback || {},
        logger: requestLogger.child({ component: "discovery-service" })
      });

      requestLogger.info("request.success", {
        statusCode: 200,
        candidates: result.candidates?.length || 0,
        totalFetched: result.summary?.totalFetched || 0,
        rawFetched: result.summary?.rawFetched || 0,
        dataSource: result.summary?.dataSource || "",
        aiReviewEnabled: Boolean(result.summary?.aiReview?.enabled)
      });
      return sendJson(res, 200, { ok: true, requestId: requestLogger.requestId, ...result });
    }

    return sendJson(res, 404, { ok: false, error: "Route not found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const isEmptyResult = error.code === "DISCOVERY_EMPTY";
    requestLogger?.[isEmptyResult ? "warn" : "error"]?.(isEmptyResult ? "request.empty" : "request.error", {
      statusCode,
      code: error.code || "INTERNAL_ERROR",
      error
    });
    return sendJson(res, statusCode, {
      ok: false,
      requestId: requestLogger?.requestId,
      error: error.message,
      code: error.code || "INTERNAL_ERROR"
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`KOL Lite API listening on http://127.0.0.1:${PORT}`);
});

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });

  if (statusCode === 204) {
    res.end();
    return;
  }

  res.end(JSON.stringify(payload));
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

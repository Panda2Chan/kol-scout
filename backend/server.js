import { createServer } from "node:http";
import { discoverCreators } from "./services/discovery-service.js";
import { buildCreatorSearchPlan, matchCreators } from "./services/match-service.js";
import { buildAiCreatorSearchPlan } from "./services/ai-search-service.js";
import { createPlatformRegistry } from "./platforms/registry.js";

const PORT = Number(process.env.PORT || 8787);
const registry = createPlatformRegistry();

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      return sendJson(res, 204, {});
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "kol-lite-api" });
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
              label: "打开 X 全站用户搜索",
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
      const body = await readJson(req);
      const result = await discoverCreators(body.brief || {}, registry, {
        platform: body.platform || "x",
        locale: body.locale || "zh-CN",
        limit: body.limit || 20,
        filters: body.filters || {}
      });

      return sendJson(res, 200, { ok: true, ...result });
    }

    return sendJson(res, 404, { ok: false, error: "Route not found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return sendJson(res, statusCode, { ok: false, error: error.message, code: error.code || "INTERNAL_ERROR" });
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

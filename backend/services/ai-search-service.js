import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 45_000;
const AI_POSTPROCESS_TIMEOUT_MS = 45_000;
const AI_POSTPROCESS_LIMIT = 30;
const PLAN_CACHE_TTL_MS = 10 * 60 * 1000;
const AI_WEB_SEARCH_TIMEOUT_MS = 90_000;
const planCache = new Map();

const SYSTEM_PROMPT = `
你是 KOL 运营搜索规划器。把用户需求改写成 X/Twitter 站内搜索策略。
只输出严格 JSON；不要解释；不要编造账号。
JSON 字段：kolOpsRelevant, intent, queries, positiveTerms, mustHave, shouldHave, exclude, qualitySignals, notes。
通用查询规范：
1. queries 必须是 4-6 条可执行的 X/Twitter 全站搜索查询，优先英文，必要时补充中文/日文/韩文同义词。
2. 每条 query 必须包含 site:x.com 或 site:twitter.com，并覆盖「人群/地区/性别/垂类/内容形态」中至少 2 类要素。
3. 不要返回账号 handle，不要编造账号；只规划搜索词。
4. 必须面向 KOL 运营找 OP/creator/influencer，优先个人创作者、可合作账号、有商务联系方式或稳定内容输出的账号。
5. exclude 必须包含 giveaway/airdrop/adult/porn/follow back/official/news/shop/store/brand/agency。
6. qualitySignals 必须覆盖：个人账号、垂直内容、近期活跃、简介完整、真实互动、可联系。
7. 如果用户给出粉丝数下限，把它写入 mustHave/qualitySignals，但不要用不可靠语法强行塞进 query。
`.trim();

const TIKTOK_SYSTEM_PROMPT = `
你是 KOL 运营搜索规划器。把用户需求改写成 TikTok 创作者全站搜索策略。
只输出严格 JSON；不要解释；不要编造账号。
JSON 字段：kolOpsRelevant, intent, queries, positiveTerms, mustHave, shouldHave, exclude, qualitySignals, notes。
通用查询规范：
1. queries 必须是 4-8 条可执行的 TikTok 公开网页搜索查询，优先英文，必要时补充中文/日文/韩文同义词。
2. 每条 query 必须面向 site:tiktok.com/@ 或 site:www.tiktok.com/@，覆盖「垂类/人群/地区/性别/内容形态/标签」中至少 2 类要素。
3. query 可包含 TikTok 常用标签词，例如 #beautytok、#skintok、#cosplay、#fitness，但不要编造账号 handle。
4. 必须面向 KOL 运营找 OP/creator/influencer，优先个人创作者、可合作账号、有商务联系方式或稳定内容输出的账号。
5. exclude 必须包含 giveaway/airdrop/adult/porn/follow back/official/news/shop/store/brand/agency。
6. qualitySignals 必须覆盖：个人账号、垂直内容、近期活跃、简介完整、真实互动、可联系。
7. 如果用户给出粉丝数下限，把它写入 mustHave/qualitySignals，但不要用不可靠语法强行塞进 query。
`.trim();

export class AiSearchError extends Error {
  constructor(message, code = "AI_SEARCH_FAILED", statusCode = 502) {
    super(message);
    this.name = "AiSearchError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function buildAiCreatorSearchPlan(brief, fallbackPlan, options = {}) {
  const config = loadAiConfig(options);
  const basePlan = fallbackPlan || {};
  const requireAi = options.requireAi ?? process.env.AI_SEARCH_REQUIRED === "true";

  if (!config.apiKey || !config.baseUrl) {
    if (requireAi) {
      throw new AiSearchError(
        "未找到 OpenAI/cc switch API 配置，无法执行 AI 全站匹配。",
        "AI_CONFIG_MISSING",
        424
      );
    }

    return withFallback(basePlan, {
      enabled: false,
      reason: "未找到 OpenAI/cc switch API 配置"
    });
  }

  const prompt = buildKolOpsPrompt(brief, basePlan, options);
  const cacheKey = buildPlanCacheKey(brief, basePlan, config, options.feedbackSummary);
  const cached = getCachedPlan(cacheKey);
  if (cached) return cached;

  try {
    const searchSignal = createTimeoutSignal(
      readTimeoutMs(process.env.AI_SEARCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      options.signal
    );
    const aiPlan = await requestAiSearchPlan(config, prompt, searchSignal);
    const normalized = normalizeAiPlan(aiPlan, basePlan);
    const plan = {
      ...mergeSearchPlan(basePlan, normalized),
      aiSearch: {
        enabled: true,
        provider: config.provider,
        model: config.model,
        intent: normalized.intent,
        kolOpsRelevant: normalized.kolOpsRelevant,
        promptVersion: "kol-search-v1",
        generatedAt: Date.now(),
        prompt: prompt.user,
        queries: normalized.queries,
        mustHave: normalized.mustHave,
        shouldHave: normalized.shouldHave,
        exclude: normalized.exclude,
        qualitySignals: normalized.qualitySignals
      }
    };
    planCache.set(cacheKey, { expiresAt: Date.now() + PLAN_CACHE_TTL_MS, plan });
    return plan;
  } catch (error) {
    if (requireAi) {
      throw new AiSearchError(`AI 搜索计划失败：${formatAiErrorMessage(error)}`, "AI_SEARCH_FAILED", 502);
    }

    return withFallback(basePlan, {
      enabled: false,
      provider: config.provider,
      model: config.model,
      reason: `AI 搜索计划未完成，已使用规则兜底：${formatAiErrorMessage(error)}`
    });
  }
}

export async function discoverCreatorsWithAiWebSearch(brief, plan, options = {}) {
  const config = loadAiConfig(options);
  if (!config.apiKey || !config.baseUrl) {
    throw new AiSearchError("未找到 OpenAI/cc switch API 配置，无法执行 AI Web Search。", "AI_CONFIG_MISSING", 424);
  }

  const prompt = buildAiWebSearchPrompt(brief, plan, options);
  const searchSignal = createTimeoutSignal(
    readTimeoutMs(process.env.AI_WEB_SEARCH_TIMEOUT_MS, AI_WEB_SEARCH_TIMEOUT_MS),
    options.signal
  );
  const response = await fetch(config.responsesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      instructions: prompt.system,
      input: prompt.user,
      tools: [{ type: "web_search", search_context_size: "low" }],
      tool_choice: "required",
      max_output_tokens: 1100,
      store: false
    }),
    signal: searchSignal
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AiSearchError(payload.error?.message || `AI Web Search 请求失败：${response.status}`);
  }

  const parsed = parseJsonObject(extractResponseText(payload));
  const creators = normalizeAiWebSearchCreators(parsed.creators || parsed.results || [], {
    provider: config.provider,
    model: config.model
  });
  if (!creators.length) throw new AiSearchError("AI Web Search 未返回可用 OP 候选。");

  return {
    creators,
    meta: {
      enabled: true,
      provider: config.provider,
      model: config.model,
      tool: "web_search",
      promptVersion: "kol-ai-web-search-v1",
      generatedAt: Date.now(),
      queries: plan.aiSearch?.queries || [],
      webRequests: payload.tool_usage?.web_search?.num_requests ?? null
    }
  };
}

export async function postProcessCreatorsWithAi(brief, creators = [], options = {}) {
  const sourceCreators = Array.isArray(creators) ? creators : [];
  const limit = clampNumber(Number(options.limit || process.env.AI_POSTPROCESS_LIMIT || AI_POSTPROCESS_LIMIT), 1, 60);
  const candidates = sourceCreators.slice(0, limit);

  if (!candidates.length) {
    return {
      creators: sourceCreators,
      meta: { enabled: false, reason: "没有可复核候选" }
    };
  }

  if (process.env.AI_POSTPROCESS_DISABLED === "true") {
    return {
      creators: sourceCreators,
      meta: { enabled: false, reason: "AI 后处理已关闭" }
    };
  }

  const config = loadAiConfig(options);
  if (!config.apiKey || !config.baseUrl) {
    return {
      creators: sourceCreators,
      meta: { enabled: false, reason: "未找到 OpenAI/cc switch API 配置" }
    };
  }

  const prompt = buildAiCreatorReviewPrompt(brief, candidates, options);
  const signal = createTimeoutSignal(
    readTimeoutMs(options.timeoutMs || process.env.AI_POSTPROCESS_TIMEOUT_MS, AI_POSTPROCESS_TIMEOUT_MS),
    options.signal
  );

  try {
    const payload = await requestAiJson(config, prompt, signal, 1800);
    const reviewMap = normalizeAiCreatorReviews(payload);
    return {
      creators: mergeAiCreatorReviews(sourceCreators, reviewMap),
      meta: {
        enabled: true,
        provider: config.provider,
        model: config.model,
        promptVersion: "kol-ai-review-v1",
        generatedAt: Date.now(),
        reviewed: reviewMap.size,
        submitted: candidates.length,
        feedbackUsed: Boolean(options.feedbackSummary?.total)
      }
    };
  } catch (error) {
    return {
      creators: sourceCreators,
      meta: {
        enabled: false,
        provider: config.provider,
        model: config.model,
        error: formatAiErrorMessage(error),
        fallback: "discovery-rules-v1"
      }
    };
  }
}

function buildPlanCacheKey(brief, fallbackPlan, config, feedbackSummary = {}) {
  return [
    config.provider,
    config.model,
    fallbackPlan.platform || "x",
    String(brief.rawText || "").trim().toLowerCase(),
    (fallbackPlan.positiveTerms || []).join("|"),
    (fallbackPlan.negativeTerms || []).join("|"),
    (feedbackSummary.preferredTags || []).join("|"),
    (feedbackSummary.rejectedTags || []).join("|"),
    feedbackSummary.saved || 0,
    feedbackSummary.ignored || 0,
    feedbackSummary.removed || 0
  ].join("::");
}

function getCachedPlan(cacheKey) {
  const cached = planCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    planCache.delete(cacheKey);
    return null;
  }
  return {
    ...cached.plan,
    aiSearch: {
      ...cached.plan.aiSearch,
      cached: true
    }
  };
}

export function loadAiConfig(options = {}) {
  const envConfig = {
    apiKey: process.env.OPENAI_API_KEY || process.env.AI_OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_BASE_URL || process.env.AI_OPENAI_BASE_URL || "",
    model: process.env.OPENAI_MODEL || process.env.AI_SEARCH_MODEL || DEFAULT_MODEL,
    provider: "env"
  };

  if (envConfig.apiKey && envConfig.baseUrl) {
    return normalizeConfig(envConfig);
  }

  const ccConfig = loadCcSwitchCodexConfig(options);
  return normalizeConfig({
    apiKey: envConfig.apiKey || ccConfig.apiKey,
    baseUrl: envConfig.baseUrl || ccConfig.baseUrl,
    model: process.env.AI_SEARCH_MODEL || envConfig.model || ccConfig.model || DEFAULT_MODEL,
    provider: ccConfig.provider || envConfig.provider
  });
}

function loadCcSwitchCodexConfig(options = {}) {
  const home = options.homeDir || homedir();
  const settingsPath = join(home, ".cc-switch", "settings.json");
  const dbPath = join(home, ".cc-switch", "cc-switch.db");

  if (!existsSync(settingsPath) || !existsSync(dbPath)) return {};

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const providerId = settings.currentProviderCodex;
    if (!providerId) return {};

    const safeProviderId = sqlString(providerId);
    const rows = querySqliteJson(
      dbPath,
      `select settings_config from providers where app_type='codex' and id=${safeProviderId} limit 1;`
    );
    const endpointRows = querySqliteJson(
      dbPath,
      `select url from provider_endpoints where app_type='codex' and provider_id=${safeProviderId} order by id asc limit 1;`
    );
    const config = JSON.parse(rows[0]?.settings_config || "{}");
    const tomlText = String(config.config || "");

    return {
      apiKey: config.auth?.OPENAI_API_KEY || "",
      baseUrl: parseTomlString(tomlText, "base_url") || endpointRows[0]?.url || "",
      model: parseTomlString(tomlText, "model") || DEFAULT_MODEL,
      provider: "cc-switch"
    };
  } catch {
    return {};
  }
}

function querySqliteJson(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    timeout: 5000
  });
  return JSON.parse(output || "[]");
}

function sqlString(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function parseTomlString(text, key) {
  const match = String(text || "").match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]+)"`, "m"));
  return match?.[1] || "";
}

function normalizeConfig(config) {
  const baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
  return {
    apiKey: config.apiKey || "",
    baseUrl,
    responsesUrl: baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`,
    chatCompletionsUrl: baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`,
    model: config.model || DEFAULT_MODEL,
    provider: config.provider || "unknown"
  };
}

function buildKolOpsPrompt(brief, fallbackPlan, options) {
  const platform = options.platform || fallbackPlan.platform || "x";
  const user = [
    `platform=${platform}`,
    `locale=${options.locale || "zh-CN"}`,
    `userInput=${brief.rawText || ""}`,
    `fallbackTerms=${(fallbackPlan.positiveTerms || []).join(", ")}`,
    `negativeTerms=${(fallbackPlan.negativeTerms || []).join(", ")}`,
    `filters=${JSON.stringify(options.filters || {})}`,
    `feedback=${JSON.stringify(compactFeedbackSummary(options.feedbackSummary))}`,
    "Return JSON only. Keep arrays short. Do not include account handles."
  ].join("\n");

  return {
    system: buildSearchPlanSystemPrompt(platform),
    user
  };
}

function buildSearchPlanSystemPrompt(platform) {
  return String(platform || "").toLowerCase() === "tiktok" ? TIKTOK_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

function buildAiWebSearchPrompt(brief, plan, options) {
  const system = `
你是 KOL 运营全站搜索智能体。必须使用 web_search 查找真实公开 X/Twitter OP 主页。
只返回严格 JSON，不要解释，不要编造账号。
JSON 格式：{"creators":[{"handle":"@...","name":"","profileUrl":"https://x.com/...","bio":"","followers":null,"email":"","evidence":"","tags":[]}]}
通用搜索规范：
1. 必须真实使用 web_search 检索公开网页，优先 X/Twitter profile page。
2. 搜索 query 要覆盖用户 Brief 的地区/性别/垂类/内容形态/语言同义词。
3. 只返回个人 OP/creator/influencer，不返回品牌、店铺、新闻媒体、机构、聚合搬运、bot、成人擦边、抽奖互关账号。
4. 每个候选必须有 profileUrl 和 handle；必须尽量给出 bio、followers、email、evidence。
5. followers 必须是数字；无法确认则 null。email 只返回公开简介或公开资料中出现的邮箱。
6. evidence 必须说明命中的公开证据，不要编造粉丝量或联系方式。
7. 如果设置粉丝下限，优先返回达到下限的账号；无法确认粉丝量的账号排后或不返回。
`.trim();

  const user = [
    `platform=${options.platform || plan.platform || "x"}`,
    `locale=${options.locale || "zh-CN"}`,
    `userInput=${brief.rawText || ""}`,
    `positiveTerms=${(plan.positiveTerms || []).join(", ")}`,
    `excludeTerms=${(plan.negativeTerms || []).join(", ")}`,
    `searchHints=${(plan.aiSearch?.queries || []).join(" | ")}`,
    `filters=${JSON.stringify(options.filters || {})}`,
    `limit=${Math.min(Number(options.limit || 8), 8)}`,
    "Return only real X/Twitter profile pages."
  ].join("\n");

  return { system, user };
}

function buildAiCreatorReviewPrompt(brief, creators, options) {
  const system = `
你是 KOL 运营候选复核智能体。你只基于输入的公开资料和搜索证据做清洗、重排和风险判断。
必须返回严格 JSON，不要解释，不要编造粉丝量、邮箱、地区或账号。
JSON 格式：{"reviews":[{"id":"","semanticScore":0,"evidenceConfidence":0,"collaborationFit":0,"isPersonalCreator":true,"reject":false,"rejectReason":"","cleanedBio":"","normalizedTags":[],"reasons":[],"concerns":[]}]}
评分规范：
1. semanticScore 表示候选与 Brief 的语义匹配度，0-100。
2. evidenceConfidence 表示公开证据是否足够支撑判断，0-100。
3. collaborationFit 表示是否像可合作个人创作者，0-100。
4. 店铺、品牌官方、新闻媒体、搬运聚合、bot、成人擦边、抽奖互关账号应 reject=true。
5. 粉丝数未知只能降低 evidenceConfidence，不能单独作为 reject 理由。
6. cleanedBio 只能清理模板噪声，不要补写不存在的信息。
7. Brief 或 filters 中的性别、地区、人群画像是硬约束；候选公开证据不支持或出现反向证据时必须 reject=true。
`.trim();

  const user = [
    `platform=${options.platform || "x"}`,
    `locale=${options.locale || "zh-CN"}`,
    `brief=${brief.rawText || ""}`,
    `filters=${JSON.stringify(options.filters || {})}`,
    `feedback=${JSON.stringify(compactFeedbackSummary(options.feedbackSummary))}`,
    `candidates=${JSON.stringify(creators.map(compactCreatorForAi))}`,
    "Return JSON only."
  ].join("\n");

  return { system, user };
}

async function requestAiJson(config, prompt, signal, maxTokens = 900) {
  if (process.env.AI_SEARCH_API_MODE !== "responses") {
    return requestChatCompletionsJson(config, prompt, "", signal, maxTokens);
  }

  const response = await fetch(config.responsesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      instructions: prompt.system,
      input: prompt.user,
      max_output_tokens: maxTokens,
      store: false
    }),
    signal
  }).catch((error) => ({ networkError: error }));

  if (response.networkError) {
    return requestChatCompletionsJson(config, prompt, response.networkError.message, signal, maxTokens);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return requestChatCompletionsJson(
      config,
      prompt,
      payload.error?.message || `OpenAI Responses 请求失败：${response.status}`,
      signal,
      maxTokens
    );
  }

  const text = extractResponseText(payload);
  if (!text) throw new Error("OpenAI Responses 未返回文本");
  return parseJsonObject(text);
}

async function requestChatCompletionsJson(config, prompt, previousError = "", signal, maxTokens = 900) {
  const response = await fetch(config.chatCompletionsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ],
      max_tokens: maxTokens
    }),
    signal
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || previousError || `OpenAI Chat 请求失败：${response.status}`);
  }

  const text = payload.choices?.[0]?.message?.content || "";
  if (!text) throw new Error(previousError || "OpenAI Chat 未返回文本");
  return parseJsonObject(text);
}

async function requestAiSearchPlan(config, prompt, signal) {
  if (process.env.AI_SEARCH_API_MODE !== "responses") {
    return requestChatCompletionsSearchPlan(config, prompt, "", signal);
  }

  const responsePayload = {
    model: config.model,
    instructions: prompt.system,
    input: prompt.user,
    max_output_tokens: 700,
    store: false
  };
  const response = await fetch(config.responsesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(responsePayload),
    signal
  }).catch((error) => ({ networkError: error }));

  if (response.networkError) {
    return requestChatCompletionsSearchPlan(config, prompt, response.networkError.message, signal);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return requestChatCompletionsSearchPlan(
      config,
      prompt,
      payload.error?.message || `OpenAI Responses 请求失败：${response.status}`,
      signal
    );
  }

  const text = extractResponseText(payload);
  if (!text) throw new Error("OpenAI Responses 未返回文本");
  return parseJsonObject(text);
}

async function requestChatCompletionsSearchPlan(config, prompt, previousError = "", signal) {
  const url = config.chatCompletionsUrl;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ],
      max_tokens: 700
    }),
    signal
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || previousError || `OpenAI Chat 请求失败：${response.status}`);
  }

  const text = payload.choices?.[0]?.message?.content || "";
  if (!text) throw new Error(previousError || "OpenAI Chat 未返回文本");
  return parseJsonObject(text);
}

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text;

  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const objectText = extractFirstJsonObject(raw);
    if (objectText) return JSON.parse(objectText);
    throw new Error("AI 返回不是合法 JSON");
  }
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return "";
}

function compactCreatorForAi(creator) {
  return {
    id: creator.id || "",
    platform: creator.platform || "",
    handle: creator.handle || "",
    name: creator.name || "",
    bio: truncateText(creator.bio || "", 260),
    followers: creator.metrics?.followers ?? null,
    tags: (creator.tags || []).slice(0, 10),
    matchScore: creator.match?.score ?? creator.score ?? null,
    qualityScore: creator.quality?.score ?? null,
    fakeFollowerRisk: creator.quality?.fakeFollowerRisk || "",
    reasons: (creator.match?.reasons || []).slice(0, 4),
    concerns: [...(creator.match?.concerns || []), ...(creator.quality?.concerns || [])].slice(0, 6),
    evidence: truncateText(creator.discovery?.evidenceText || creator.discovery?.summary || "", 420)
  };
}

function normalizeAiCreatorReviews(payload) {
  const reviews = payload.reviews || payload.creators || payload.results || payload.items || [];
  const byKey = new Map();

  for (const item of Array.isArray(reviews) ? reviews : []) {
    const normalized = normalizeAiCreatorReview(item);
    if (!normalized) continue;
    if (normalized.id) byKey.set(normalized.id, normalized);
    if (normalized.handle) byKey.set(normalized.handle.toLowerCase(), normalized);
  }

  return byKey;
}

function normalizeAiCreatorReview(item = {}) {
  const id = String(item.id || item.creatorId || "").trim();
  const handle = String(item.handle || "").trim();
  if (!id && !handle) return null;

  return {
    id,
    handle,
    semanticScore: normalizeScore(item.semanticScore ?? item.matchScore ?? item.relevanceScore),
    evidenceConfidence: normalizeScore(item.evidenceConfidence ?? item.confidence),
    collaborationFit: normalizeScore(item.collaborationFit ?? item.businessFit),
    isPersonalCreator: item.isPersonalCreator !== false,
    reject: Boolean(item.reject),
    rejectReason: truncateText(item.rejectReason || item.reason || "", 80),
    cleanedBio: truncateText(item.cleanedBio || item.bio || "", 220),
    normalizedTags: uniqueStrings(item.normalizedTags || item.tags || []).slice(0, 10),
    reasons: uniqueStrings(item.reasons || item.positiveSignals || []).slice(0, 4),
    concerns: uniqueStrings(item.concerns || item.risks || []).slice(0, 4),
    notes: uniqueStrings(item.notes || []).slice(0, 3)
  };
}

function mergeAiCreatorReviews(creators, reviewMap) {
  if (!reviewMap.size) return creators;

  return creators.map((creator) => {
    const review = findAiReview(creator, reviewMap);
    if (!review) return creator;

    const aiReasons = review.reasons.map((reason) => `AI复核：${reason}`);
    const aiConcerns = [
      ...review.concerns.map((concern) => `AI复核：${concern}`),
      review.reject ? `AI建议排除：${review.rejectReason || "不符合个人创作者画像"}` : "",
      review.isPersonalCreator === false ? "AI复核：疑似非个人创作者" : ""
    ].filter(Boolean);
    const cleanedBio = review.cleanedBio && !isLikelyBoilerplate(review.cleanedBio) ? review.cleanedBio : "";

    return {
      ...creator,
      bio: cleanedBio || creator.bio,
      tags: uniqueStrings([...(creator.tags || []), ...review.normalizedTags]).slice(0, 16),
      aiReview: review,
      match: {
        ...creator.match,
        provider: "discovery-ai-rerank-v1",
        reasons: uniqueStrings([...(creator.match?.reasons || []), ...aiReasons]).slice(0, 8),
        concerns: uniqueStrings([...(creator.match?.concerns || []), ...aiConcerns]).slice(0, 10),
        dimensions: {
          ...(creator.match?.dimensions || {}),
          aiSemantic: review.semanticScore,
          aiEvidence: review.evidenceConfidence,
          aiCollaboration: review.collaborationFit,
          aiPersonalCreator: review.isPersonalCreator,
          aiReject: review.reject
        }
      },
      quality: {
        ...creator.quality,
        signals: uniqueStrings([
          ...(creator.quality?.signals || []),
          review.isPersonalCreator ? "AI确认个人创作者信号" : ""
        ]),
        concerns: uniqueStrings([...(creator.quality?.concerns || []), ...aiConcerns])
      }
    };
  });
}

function findAiReview(creator, reviewMap) {
  const keys = [
    creator.id,
    creator.handle,
    String(creator.handle || "").toLowerCase(),
    creator.profileUrl
  ].filter(Boolean);
  return keys.map((key) => reviewMap.get(key)).find(Boolean) || null;
}

function normalizeAiPlan(aiPlan, fallbackPlan) {
  const positiveTerms = uniqueStrings([
    ...(aiPlan.positiveTerms || []),
    ...(fallbackPlan.positiveTerms || [])
  ]).slice(0, 18);
  const exclude = uniqueStrings([
    ...(aiPlan.exclude || []),
    ...(fallbackPlan.negativeTerms || []),
    "giveaway",
    "airdrop",
    "follow back",
    "adult",
    "porn",
    "official",
    "news",
    "shop",
    "store",
    "brand",
    "agency"
  ]).slice(0, 18);

  return {
    kolOpsRelevant: aiPlan.kolOpsRelevant !== false,
    intent: String(aiPlan.intent || fallbackPlan.query || "KOL 运营账号搜索"),
    queries: uniqueStrings(aiPlan.queries || []).slice(0, 8),
    positiveTerms,
    mustHave: uniqueStrings(aiPlan.mustHave || []).slice(0, 8),
    shouldHave: uniqueStrings(aiPlan.shouldHave || []).slice(0, 12),
    exclude,
    qualitySignals: uniqueStrings(aiPlan.qualitySignals || []).slice(0, 12),
    notes: uniqueStrings(aiPlan.notes || []).slice(0, 8)
  };
}

function compactFeedbackSummary(feedbackSummary = {}) {
  if (!feedbackSummary?.total) return {};
  return {
    total: feedbackSummary.total,
    saved: feedbackSummary.saved,
    ignored: feedbackSummary.ignored,
    removed: feedbackSummary.removed,
    preferredTags: (feedbackSummary.preferredTags || []).slice(0, 8),
    rejectedTags: (feedbackSummary.rejectedTags || []).slice(0, 8),
    savedExamples: (feedbackSummary.savedExamples || []).slice(0, 5),
    ignoredExamples: (feedbackSummary.ignoredExamples || []).slice(0, 5)
  };
}

function normalizeAiWebSearchCreators(creators, meta) {
  return (Array.isArray(creators) ? creators : [])
    .map((creator) => {
      const handle = normalizeHandle(creator.handle || extractHandle(creator.profileUrl));
      if (!handle) return null;
      const rawHandle = handle.replace(/^@/, "");
      const profileUrl = normalizeProfileUrl(creator.profileUrl, rawHandle);
      if (!profileUrl) return null;

      const evidenceText = [
        creator.evidence,
        creator.bio ? `profileBio: ${creator.bio}` : "",
        creator.email ? `email: ${creator.email}` : "",
        creator.followers ? `${creator.followers} followers` : ""
      ].filter(Boolean).join("\n");

      return {
        platform: "x",
        id: `x:${handle}`.toLowerCase(),
        name: String(creator.name || handle).trim(),
        handle,
        profileUrl,
        avatarUrl: creator.avatarUrl || "",
        bio: String(creator.bio || "").trim(),
        contact: {
          email: String(creator.email || "").trim(),
          source: creator.email ? "ai-web-search" : "",
          available: Boolean(creator.email)
        },
        metrics: {
          followers: normalizeNumber(creator.followers),
          following: normalizeNumber(creator.following),
          posts: normalizeNumber(creator.posts),
          avgEngagement: normalizeNumber(creator.avgEngagement)
        },
        tags: uniqueStrings(creator.tags || []),
        sourceProvider: "ai-web-search",
        discovery: {
          kind: "ai-web-search",
          confidence: 88,
          summary: "AI Web Search 直接检索命中该 X OP，并提取公开资料。",
          evidenceText,
          needsEnrichment: false,
          sourceProvider: "ai-web-search",
          aiProvider: meta.provider,
          aiModel: meta.model
        },
        enrichment: {
          status: "ready",
          provider: "ai-web-search"
        },
        source: {
          pageUrl: profileUrl,
          pageTitle: "AI Web Search",
          capturedAt: Date.now()
        }
      };
    })
    .filter(Boolean);
}

function normalizeHandle(handle) {
  const raw = String(handle || "").replace(/^@/, "").trim();
  return /^[A-Za-z0-9_]{1,15}$/.test(raw) ? `@${raw}` : "";
}

function extractHandle(profileUrl = "") {
  try {
    const url = new URL(profileUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!["x.com", "twitter.com"].includes(host)) return "";
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    return match ? `@${match[1]}` : "";
  } catch {
    return "";
  }
}

function normalizeProfileUrl(profileUrl, fallbackHandle) {
  const handle = extractHandle(profileUrl) || normalizeHandle(fallbackHandle);
  return handle ? `https://x.com/${handle.replace(/^@/, "")}` : "";
}

function normalizeNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  const text = String(value).trim();
  const match = text.match(/([\d,.]+)\s*([KMB万亿千]?)/i);
  if (!match) return null;
  const base = Number(match[1].replaceAll(",", ""));
  if (Number.isNaN(base)) return null;
  const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000, 千: 1_000, 万: 10_000, 亿: 100_000_000 };
  return Math.round(base * (multipliers[match[2]] || 1));
}

function mergeSearchPlan(fallbackPlan, aiPlan) {
  const positiveTerms = uniqueStrings([...aiPlan.positiveTerms, ...(fallbackPlan.positiveTerms || [])]).slice(0, 18);
  const negativeTerms = uniqueStrings([...aiPlan.exclude, ...(fallbackPlan.negativeTerms || [])]).slice(0, 18);

  return {
    ...fallbackPlan,
    provider: "ai-search-plan-v1",
    query: buildQueryFromTerms(positiveTerms, negativeTerms),
    positiveTerms,
    negativeTerms,
    aiSearch: {
      queries: aiPlan.queries,
      mustHave: aiPlan.mustHave,
      shouldHave: aiPlan.shouldHave,
      exclude: aiPlan.exclude,
      qualitySignals: aiPlan.qualitySignals
    }
  };
}

function withFallback(plan, aiSearch) {
  return {
    ...plan,
    aiSearch: {
      ...plan.aiSearch,
      ...aiSearch,
      generatedAt: Date.now()
    }
  };
}

function formatAiErrorMessage(error) {
  const message = String(error?.message || error || "");
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || /aborted|timeout/i.test(message)) {
    return "AI 请求超时";
  }
  return message || "未知错误";
}

function readTimeoutMs(value, fallback) {
  const timeoutMs = Number(value || fallback);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback;
}

function createTimeoutSignal(timeoutMs, parentSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeoutSignal;
  if (parentSignal.aborted) return parentSignal;
  if (AbortSignal.any) return AbortSignal.any([parentSignal, timeoutSignal]);

  const controller = new AbortController();
  const abort = () => {
    controller.abort(parentSignal.aborted ? parentSignal.reason : timeoutSignal.reason);
  };
  parentSignal.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function buildQueryFromTerms(positiveTerms, negativeTerms) {
  const positive = positiveTerms.length ? positiveTerms : ["kol", "creator"];
  return [
    ...positive.map(quoteTerm),
    ...negativeTerms.map((term) => `-${quoteTerm(term)}`)
  ].join(" ");
}

function quoteTerm(term) {
  const clean = String(term || "").replaceAll('"', "").trim();
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

function uniqueStrings(values) {
  return [...new Set(toArray(values)
    .flatMap((value) => toArray(value))
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
  )];
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === "object") return Object.values(value);
  return [value];
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return clampNumber(Math.round(numeric), 0, 100);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function truncateText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function isLikelyBoilerplate(text) {
  return /Browse your favorite items|TikTok Shop is now available|Visit TikTok to discover more trending creators|Skip to content|For You|Following|LIVE|Log in/i.test(String(text || ""));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const __testing = {
  compactFeedbackSummary,
  compactCreatorForAi,
  mergeAiCreatorReviews,
  normalizeAiCreatorReviews
};

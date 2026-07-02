import { buildCreatorSearchPlan, matchCreators, normalizeBrief } from "./match-service.js";
import {
  buildAiCreatorSearchPlan,
  discoverCreatorsWithAiWebSearch,
  postProcessCreatorsWithAi
} from "./ai-search-service.js";
import {
  buildThirdPartyDiscoveryCacheKey,
  getThirdPartyDiscoveryCache,
  isThirdPartyCacheDisabled,
  setThirdPartyDiscoveryCache,
  setThirdPartyDiscoveryErrorCache
} from "./discovery-cache-service.js";

const DEFAULT_FILTERS = {
  minMatchScore: 50,
  minQualityScore: 55,
  minFollowers: 0,
  maxFakeFollowerRisk: "medium"
};

const RISK_RANK = { low: 1, medium: 2, high: 3 };
const DISCOVERY_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const TIKTOK_RAW_MIN_LIMIT = 80;
const TIKTOK_RAW_MAX_LIMIT = 150;
const TIKTOK_UNKNOWN_FOLLOWER_PENALTY = 6;
const MIN_TIKTOK_WEB_PROFILE_SIGNALS = 2;

export class DiscoveryEmptyError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscoveryEmptyError";
    this.statusCode = 200;
    this.code = "DISCOVERY_EMPTY";
  }
}

export class DiscoveryTimeoutError extends Error {
  constructor(timeoutMs = DISCOVERY_TOTAL_TIMEOUT_MS, elapsedMs = 0) {
    const normalizedTimeoutMs = Number(timeoutMs || DISCOVERY_TOTAL_TIMEOUT_MS);
    const normalizedElapsedMs = Number(elapsedMs || 0);
    const timeoutLabel = formatDuration(normalizedTimeoutMs);
    const elapsedLabel = normalizedElapsedMs > 0 ? formatDuration(normalizedElapsedMs) : "";
    const message = elapsedLabel && normalizedElapsedMs < normalizedTimeoutMs * 0.9
      ? `全站匹配已等待 ${elapsedLabel}后中止（总上限 ${timeoutLabel}），请缩小筛选条件后重试。`
      : `全站匹配超过 ${timeoutLabel}，请缩小筛选条件后重试。`;
    super(message);
    this.name = "DiscoveryTimeoutError";
    this.statusCode = 504;
    this.code = "DISCOVERY_TIMEOUT";
    this.timeoutMs = normalizedTimeoutMs;
    this.elapsedMs = normalizedElapsedMs;
  }
}

export async function discoverCreators(briefInput = {}, registry, options = {}) {
  const startedAt = Date.now();
  const logger = options.logger || null;
  const totalTimeoutMs = readTimeoutMs(options.timeoutMs || process.env.DISCOVERY_TOTAL_TIMEOUT_MS, DISCOVERY_TOTAL_TIMEOUT_MS);
  const totalSignal = createTimeoutSignal(
    totalTimeoutMs,
    options.signal
  );
  const brief = normalizeBrief(briefInput);
  const platform = normalizePlatform(options.platform || brief.platforms[0] || "x");
  const provider = registry.get(platform);

  if (!provider?.discoverCreators) {
    throw new Error(`Unsupported discovery platform: ${platform}`);
  }

  const limit = clamp(Number(options.limit || 20), 1, 50);
  const filters = normalizeFilters(options.filters || {}, brief);
  const feedbackSummary = summarizeFeedback(options.feedback, platform);
  const fallbackPlan = buildCreatorSearchPlan(brief, { platform, locale: options.locale || "zh-CN" });
  logDiscovery(logger, "discovery.start", startedAt, {
    platform,
    provider: provider.sourceName || "unknown",
    limit,
    timeoutMs: totalTimeoutMs,
    filters: summarizeLogFilters(filters),
    feedbackTotal: feedbackSummary.total || 0
  });

  let stageStartedAt = Date.now();
  logDiscovery(logger, "ai_plan.start", stageStartedAt, {
    platform,
    fallbackQueryTerms: fallbackPlan.positiveTerms?.length || 0
  });
  const plan = await runWithAbort(buildAiCreatorSearchPlan(brief, fallbackPlan, {
    platform,
    locale: options.locale || "zh-CN",
    filters,
    feedbackSummary,
    requireAi: false,
    signal: totalSignal
  }), totalSignal, totalTimeoutMs, startedAt);
  logDiscovery(logger, "ai_plan.done", stageStartedAt, {
    platform: plan.platform,
    aiEnabled: Boolean(plan.aiSearch?.enabled),
    aiCached: Boolean(plan.aiSearch?.cached),
    queryCount: plan.aiSearch?.queries?.length || 0,
    positiveTerms: plan.positiveTerms?.length || 0,
    negativeTerms: plan.negativeTerms?.length || 0
  });

  const providerLogger = logger?.child?.({ component: `${platform}-provider` }) || logger;
  const discoveryOptions = {
    limit: calculateDiscoveryFetchLimit(platform, limit),
    filters,
    locale: options.locale || "zh-CN",
    signal: totalSignal,
    logger: providerLogger
  };
  let aiWebSearch = null;
  let sourceDiagnostics = null;
  let dataSource = provider.sourceName || "unknown";
  let fetched = [];
  let thirdPartyCache = null;
  let thirdPartyCacheKey = null;

  if (platform === "x" && plan.aiSearch?.enabled && process.env.AI_WEB_SEARCH_DISABLED !== "true") {
    stageStartedAt = Date.now();
    logDiscovery(logger, "ai_web_search.start", stageStartedAt, {
      platform,
      limit: Math.min(Math.max(limit, 8), 20)
    });
    try {
      aiWebSearch = await runWithAbort(discoverCreatorsWithAiWebSearch(brief, plan, {
        ...discoveryOptions,
        platform,
        limit: Math.min(Math.max(limit, 8), 20)
      }), totalSignal, totalTimeoutMs, startedAt);
      fetched = aiWebSearch.creators;
      fetched = await runWithAbort(
        enrichAiWebSearchCreators(fetched, provider, 20, totalSignal, totalTimeoutMs, startedAt),
        totalSignal,
        totalTimeoutMs,
        startedAt
      );
      dataSource = "ai-web-search";
      logDiscovery(logger, "ai_web_search.done", stageStartedAt, {
        fetched: fetched.length,
        dataSource
      });
    } catch (error) {
      if (totalSignal.aborted) throw createDiscoveryTimeoutError(totalTimeoutMs, startedAt);
      logDiscovery(logger, "ai_web_search.fallback", stageStartedAt, {
        error: error.message,
        fallback: provider.sourceName || "unknown"
      }, "warn");
      aiWebSearch = {
        enabled: false,
        error: error.message,
        fallback: provider.sourceName || "unknown"
      };
    }
  }

  if (!fetched.length) {
    throwIfAborted(totalSignal, totalTimeoutMs, startedAt);
    stageStartedAt = Date.now();
    thirdPartyCacheKey = buildThirdPartyDiscoveryCacheKey({
      platform,
      provider: provider.sourceName || "unknown",
      brief,
      filters,
      limit: discoveryOptions.limit,
      locale: options.locale || "zh-CN"
    });
    const cached = getThirdPartyDiscoveryCache(thirdPartyCacheKey);
    thirdPartyCache = cached ? {
      enabled: true,
      hit: true,
      kind: cached.kind,
      key: cached.cacheKeyHash,
      ageMs: cached.ageMs,
      expiresInMs: cached.expiresInMs,
      ttlMs: cached.ttlMs
    } : {
      enabled: !isThirdPartyCacheDisabled(),
      hit: false,
      key: thirdPartyCacheKey.hash
    };

    if (cached?.kind === "success") {
      fetched = cached.creators;
      sourceDiagnostics = Array.isArray(fetched) ? fetched.discoveryMeta || null : null;
      dataSource = `${provider.sourceName || "unknown"}-cache`;
      logDiscovery(logger, "provider_discovery.cache_hit", stageStartedAt, {
        source: provider.sourceName || "unknown",
        cacheKey: cached.cacheKeyHash,
        ageMs: cached.ageMs,
        expiresInMs: cached.expiresInMs,
        fetched: fetched.length,
        rawFetched: sourceDiagnostics?.rawFetched ?? fetched.length
      });
    } else if (cached?.kind === "error") {
      logDiscovery(logger, "provider_discovery.cache_empty", stageStartedAt, {
        source: provider.sourceName || "unknown",
        cacheKey: cached.cacheKeyHash,
        ageMs: cached.ageMs,
        expiresInMs: cached.expiresInMs,
        error: cached.error
      }, "warn");
      throw cached.error;
    }
  }

  if (!fetched.length) {
    logDiscovery(logger, "provider_discovery.start", stageStartedAt, {
      platform,
      source: provider.sourceName || "unknown",
      rawLimit: discoveryOptions.limit,
      cacheKey: thirdPartyCache?.key || ""
    });
    try {
      fetched = await runWithAbort(provider.discoverCreators(plan, discoveryOptions), totalSignal, totalTimeoutMs, startedAt);
      const cacheWrite = fetched.length ? setThirdPartyDiscoveryCache(thirdPartyCacheKey, fetched) : null;
      thirdPartyCache = {
        ...(thirdPartyCache || {}),
        enabled: !isThirdPartyCacheDisabled(),
        hit: false,
        stored: Boolean(cacheWrite),
        key: cacheWrite?.cacheKeyHash || thirdPartyCache?.key || thirdPartyCacheKey.hash,
        ttlMs: cacheWrite?.ttlMs || thirdPartyCache?.ttlMs || null
      };
    } catch (error) {
      if (totalSignal.aborted) throw createDiscoveryTimeoutError(totalTimeoutMs, startedAt);
      const cacheWrite = setThirdPartyDiscoveryErrorCache(thirdPartyCacheKey, error);
      thirdPartyCache = {
        ...(thirdPartyCache || {}),
        enabled: !isThirdPartyCacheDisabled(),
        hit: false,
        stored: Boolean(cacheWrite),
        kind: cacheWrite ? "error" : thirdPartyCache?.kind,
        key: cacheWrite?.cacheKeyHash || thirdPartyCache?.key || thirdPartyCacheKey.hash,
        ttlMs: cacheWrite?.ttlMs || thirdPartyCache?.ttlMs || null
      };
      logDiscovery(logger, error.code === "DISCOVERY_EMPTY" ? "provider_discovery.empty" : "provider_discovery.error", stageStartedAt, {
        source: provider.sourceName || "unknown",
        cacheStored: Boolean(cacheWrite),
        cacheKey: cacheWrite?.cacheKeyHash || thirdPartyCacheKey.hash,
        error
      }, error.code === "DISCOVERY_EMPTY" ? "warn" : "error");
      throw error;
    }
    throwIfAborted(totalSignal, totalTimeoutMs, startedAt);
    sourceDiagnostics = Array.isArray(fetched) ? fetched.discoveryMeta || null : null;
    dataSource = aiWebSearch?.fallback ? `${provider.sourceName || "unknown"}-fallback` : provider.sourceName || "unknown";
    logDiscovery(logger, "provider_discovery.done", stageStartedAt, {
      source: dataSource,
      fetched: fetched.length,
      rawFetched: sourceDiagnostics?.rawFetched ?? fetched.length,
      sourceCount: sourceDiagnostics?.sources?.length || 0,
      errors: sourceDiagnostics?.errors?.length || 0,
      cacheStored: Boolean(thirdPartyCache?.stored),
      cacheKey: thirdPartyCache?.key || ""
    });
  }

  if (!fetched.length) {
    const error = new DiscoveryEmptyError("真实数据源未返回候选账号，请调整关键词或配置 KOL_DATA_API_URL 三方数据源。");
    const cacheWrite = thirdPartyCacheKey ? setThirdPartyDiscoveryErrorCache(thirdPartyCacheKey, error) : null;
    thirdPartyCache = {
      ...(thirdPartyCache || {}),
      enabled: !isThirdPartyCacheDisabled(),
      hit: false,
      stored: Boolean(cacheWrite),
      kind: cacheWrite ? "error" : thirdPartyCache?.kind,
      key: cacheWrite?.cacheKeyHash || thirdPartyCache?.key || thirdPartyCacheKey?.hash || "",
      ttlMs: cacheWrite?.ttlMs || thirdPartyCache?.ttlMs || null
    };
    logDiscovery(logger, "provider_discovery.empty", stageStartedAt, {
      source: provider.sourceName || "unknown",
      cacheStored: Boolean(cacheWrite),
      cacheKey: thirdPartyCache.key,
      error
    }, "warn");
    throw error;
  }

  stageStartedAt = Date.now();
  const normalized = dedupeCreators(
    fetched.map((creator) => normalizeDiscoveredCreator(creator, platform))
  );
  const matchById = new Map(matchCreators(brief, normalized).map((item) => [item.creatorId, item.match]));

  const ruleAnalyzed = normalized.map((creator) => {
    const baseMatch = matchById.get(creator.id) || {};
    const quality = analyzeCreatorQuality(creator);
    const followerUnknownPenalty = getUnknownFollowerPenalty(creator, filters);
    const finalScore = calculateFinalScore(baseMatch.score || 0, quality, followerUnknownPenalty);
    const followerUnknownConcern = followerUnknownPenalty ? ["粉丝数未知，已降权保留"] : [];

    return {
      ...creator,
      quality,
      match: {
        ...baseMatch,
        score: finalScore,
        provider: "discovery-rules-v1",
        reasons: buildDiscoveryReasons(baseMatch, quality),
        concerns: [...(baseMatch.concerns || []), ...quality.concerns, ...followerUnknownConcern],
        dimensions: {
          ...(baseMatch.dimensions || {}),
          baseMatch: baseMatch.score || 0,
          quality: quality.score,
          followerUnknownPenalty,
          sourceRelevance: creator.relevanceScore ?? creator.discovery?.relevanceScore ?? null,
          fakeFollowerRisk: quality.fakeFollowerRisk
        }
      },
      score: finalScore
    };
  });
  let aiReview = null;
  let analyzed = applyPostProcessingScores(ruleAnalyzed, feedbackSummary);
  logDiscovery(logger, "rules_analysis.done", stageStartedAt, {
    fetched: fetched.length,
    normalized: normalized.length,
    analyzed: analyzed.length
  });

  const remainingForAiMs = totalTimeoutMs - (Date.now() - startedAt);
  if (remainingForAiMs <= 20_000) {
    aiReview = {
      enabled: false,
      reason: "剩余时间不足，已跳过 AI 复核",
      fallback: "discovery-rules-v1"
    };
    logDiscovery(logger, "ai_review.skipped", startedAt, {
      remainingMs: remainingForAiMs,
      reason: aiReview.reason
    }, "warn");
  } else {
    stageStartedAt = Date.now();
    const aiReviewTimeoutMs = Math.min(45_000, Math.max(10_000, remainingForAiMs - 5_000));
    logDiscovery(logger, "ai_review.start", stageStartedAt, {
      candidates: analyzed.length,
      limit: Math.min(Math.max(limit * 2, 20), 40),
      timeoutMs: aiReviewTimeoutMs
    });
    try {
      const aiResult = await runWithAbort(postProcessCreatorsWithAi(brief, analyzed, {
        platform,
        locale: options.locale || "zh-CN",
        filters,
        feedbackSummary,
        limit: Math.min(Math.max(limit * 2, 20), 40),
        timeoutMs: aiReviewTimeoutMs,
        signal: totalSignal
      }), totalSignal, totalTimeoutMs, startedAt);
      aiReview = aiResult.meta;
      analyzed = applyPostProcessingScores(aiResult.creators, feedbackSummary);
      logDiscovery(logger, "ai_review.done", stageStartedAt, {
        enabled: Boolean(aiReview?.enabled),
        reviewed: aiReview?.reviewed || aiResult.creators?.length || 0,
        fallback: aiReview?.fallback || ""
      });
    } catch (error) {
      if (totalSignal.aborted) throw createDiscoveryTimeoutError(totalTimeoutMs, startedAt);
      logDiscovery(logger, "ai_review.fallback", stageStartedAt, {
        error: error.message,
        fallback: "discovery-rules-v1"
      }, "warn");
      aiReview = {
        enabled: false,
        error: error.message,
        fallback: "discovery-rules-v1"
      };
    }
  }

  const rejected = [];
  const kept = [];

  for (const creator of analyzed) {
    const reason = getFilteredReason(creator, filters);
    if (reason) {
      rejected.push({
        id: creator.id,
        name: creator.name,
        handle: creator.handle,
        reason
      });
      continue;
    }
    kept.push(creator);
  }

  const candidates = kept.sort((a, b) => b.score - a.score).slice(0, limit);
  logDiscovery(logger, "filter.done", startedAt, {
    kept: candidates.length,
    filtered: rejected.length,
    filteredReasons: countReasons(rejected),
    totalElapsedMs: Date.now() - startedAt
  });

  return {
    platform,
    plan,
    filters,
    candidates,
    rejected: rejected.slice(0, 20),
    summary: {
      requestedLimit: limit,
      rawLimit: discoveryOptions.limit,
      rawFetched: sourceDiagnostics?.rawFetched ?? fetched.length,
      totalFetched: normalized.length,
      deduped: normalized.length,
      analyzed: analyzed.length,
      kept: candidates.length,
      filtered: rejected.length,
      filteredReasons: countReasons(rejected),
      dataSource,
      sourceDiagnostics,
      thirdPartyCache,
      feedback: serializeFeedbackSummary(feedbackSummary),
      aiSearch: {
        enabled: Boolean(plan.aiSearch?.enabled),
        provider: plan.aiSearch?.provider || "",
        model: plan.aiSearch?.model || "",
        cached: Boolean(plan.aiSearch?.cached),
        reason: plan.aiSearch?.reason || "",
        queries: plan.aiSearch?.queries || [],
        webSearch: aiWebSearch?.meta || (aiWebSearch ? {
          enabled: false,
          error: aiWebSearch.error || "",
          fallback: aiWebSearch.fallback || ""
        } : null)
      },
      aiReview
    }
  };
}

function readTimeoutMs(value, fallback) {
  const timeoutMs = Number(value || fallback);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback;
}

function logDiscovery(logger, event, stageStartedAt, fields = {}, level = "info") {
  if (!logger?.[level]) return;
  logger[level](event, {
    stageElapsedMs: stageStartedAt ? Date.now() - stageStartedAt : undefined,
    ...fields
  });
}

function summarizeLogFilters(filters = {}) {
  return {
    minMatchScore: filters.minMatchScore ?? null,
    minQualityScore: filters.minQualityScore ?? null,
    minFollowers: filters.minFollowers ?? null,
    country: filters.country || "",
    maxFakeFollowerRisk: filters.maxFakeFollowerRisk || ""
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
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

function throwIfAborted(signal, timeoutMs, startedAt = 0) {
  if (!signal?.aborted) return;
  throw createDiscoveryTimeoutError(timeoutMs, startedAt);
}

function runWithAbort(promise, signal, timeoutMs, startedAt = 0) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createDiscoveryTimeoutError(timeoutMs, startedAt));

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(createDiscoveryTimeoutError(timeoutMs, startedAt)), { once: true });
    })
  ]);
}

function createDiscoveryTimeoutError(timeoutMs, startedAt = 0) {
  const elapsedMs = startedAt ? Date.now() - startedAt : 0;
  return new DiscoveryTimeoutError(timeoutMs, elapsedMs);
}

async function enrichAiWebSearchCreators(creators, provider, maxEnrichCount, signal, timeoutMs, startedAt) {
  if (!provider?.enrich || !Array.isArray(creators) || !creators.length) return creators;

  const enriched = [];
  for (const creator of creators) {
    if (enriched.length >= maxEnrichCount) {
      enriched.push(creator);
      continue;
    }

    enriched.push(await runWithAbort(provider.enrich(creator, { signal }), signal, timeoutMs, startedAt));
  }
  return enriched;
}

export function analyzeCreatorQuality(creator) {
  const metrics = creator.metrics || {};
  const followers = Number(metrics.followers || 0);
  const following = Number(metrics.following || 0);
  const posts = Number(metrics.posts || 0);
  const avgEngagement = Number(metrics.avgEngagement || metrics.averageEngagement || 0);
  const engagementRate = followers && avgEngagement ? avgEngagement / followers : null;
  const haystack = [
    creator.name,
    creator.handle,
    creator.bio,
    creator.discovery?.evidenceText,
    ...(creator.tags || [])
  ].join(" ").toLowerCase();

  const signals = [];
  const concerns = [];
  let score = 70;
  let fakeFollowerRisk = "low";

  if (creator.bio && creator.bio.length >= 40) {
    score += 8;
    signals.push("简介信息完整");
  } else {
    score -= 12;
    concerns.push("简介过短或缺失");
  }

  if (followers > 0) score += 6;
  if (posts >= 100) score += 6;
  if (creator.avatarUrl) score += 4;

  if (creator.discovery?.kind === "web-search" && !(creator.tags || []).length) {
    score -= 20;
    concerns.push("搜索结果缺少可验证的主题命中");
  }

  if (engagementRate != null) {
    if (engagementRate >= 0.02) {
      score += 12;
      signals.push("互动率较健康");
    } else if (engagementRate >= 0.006) {
      score += 5;
    } else if (followers >= 50_000) {
      score -= 35;
      fakeFollowerRisk = "high";
      concerns.push("粉丝量较高但互动率异常偏低");
    } else {
      score -= 12;
      fakeFollowerRisk = "medium";
      concerns.push("互动率偏低");
    }
  } else if (followers >= 20_000) {
    score -= 8;
    fakeFollowerRisk = "medium";
    concerns.push("缺少互动数据，需二次校验粉丝质量");
  }

  if (followers >= 10_000 && following > followers * 1.2) {
    score -= 18;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("关注数相对粉丝数异常偏高");
  }

  if (posts > 0 && posts < 20) {
    score -= 18;
    concerns.push("内容沉淀过少");
  }

  if (/(giveaway|airdrop|follow back|dm for promo|100%|博彩|成人|抽奖|擦边|互关|私信互关|premium\+|do not follow|不要关注|フォローしない|rt\/qrt|deadlykalesh|gharkekalesh)/i.test(haystack)) {
    score -= 25;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "high");
    concerns.push("命中低质量或高风险内容信号");
  }

  if (/(official|store|shop|brand|shein|news|shopping|官网|旗舰店|官方|新闻)/i.test(haystack)) {
    score -= 18;
    concerns.push("存在品牌或媒体弱信号，需复核");
  }

  if (isLikelyBrandAccount(creator, haystack)) {
    score -= 35;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("疑似品牌号，不符合个人 OP 画像");
  }

  if (/(we do not own|do not own any photos|re-?post|owner'?s name|搬运|转载|合集|collection|curated|fan account)/i.test(haystack)) {
    score -= 32;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("疑似搬运或聚合账号，不符合个人 OP 画像");
  }

  if (/(showcas(?:e|ing) our products|free shipping|coupon|costume shop|cosplay shop|supplier|wholesale|商品链接|产品目录|店铺链接)/i.test(haystack)) {
    score -= 35;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("疑似商品或店铺账号，不符合个人 OP 画像");
  }

  if (String(creator.name || "").length > 100 && !creator.bio) {
    score -= 28;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("搜索标题解析异常，无法验证创作者身份");
  }

  if (creator.name === "X" && !creator.bio && !(creator.tags || []).length) {
    score -= 30;
    fakeFollowerRisk = maxRisk(fakeFollowerRisk, "medium");
    concerns.push("主页信息缺失，无法验证创作者身份");
  }

  score = clamp(Math.round(score), 0, 100);

  return {
    score,
    level: score >= 75 ? "high" : score >= 55 ? "medium" : "low",
    fakeFollowerRisk,
    engagementRate: engagementRate == null ? null : Number(engagementRate.toFixed(4)),
    signals,
    concerns
  };
}

function normalizeDiscoveredCreator(input, platform) {
  const handle = normalizeHandle(input.handle || extractHandle(input.profileUrl));
  const rawHandle = handle.replace(/^@/, "");

  return {
    id: input.id || `${platform}:${handle || input.profileUrl || input.name}`.toLowerCase(),
    platform,
    name: input.name || handle || "Unknown creator",
    handle,
    profileUrl: input.profileUrl || buildProfileUrl(platform, rawHandle),
    avatarUrl: input.avatarUrl || "",
    bio: cleanCreatorBio(input.bio),
    contact: {
      email: input.contact?.email || "",
      source: input.contact?.source || "",
      available: Boolean(input.contact?.email)
    },
    metrics: {
      followers: input.metrics?.followers ?? null,
      following: input.metrics?.following ?? null,
      likes: input.metrics?.likes ?? null,
      posts: input.metrics?.posts ?? null,
      avgEngagement: input.metrics?.avgEngagement ?? input.metrics?.averageEngagement ?? null
    },
    relevanceScore: input.relevanceScore ?? input.discovery?.relevanceScore ?? null,
    tags: input.tags || [],
    discovery: {
      kind: input.discovery?.kind || "third-party-search",
      confidence: input.discovery?.confidence ?? 86,
      summary: input.discovery?.summary || "来自全站数据源的候选，已做匹配和质量初筛。",
      evidenceText: cleanEvidenceText(input.discovery?.evidenceText || [input.bio, ...(input.tags || [])].filter(Boolean).join(" ")),
      needsEnrichment: Boolean(input.discovery?.needsEnrichment),
      relevanceScore: input.discovery?.relevanceScore ?? input.relevanceScore ?? null,
      sourceProvider: input.discovery?.sourceProvider || input.sourceProvider || "third-party"
    },
    enrichment: {
      status: input.enrichment?.status || (input.discovery?.needsEnrichment ? "partial" : "enriched"),
      provider: input.enrichment?.provider || input.sourceProvider || "third-party",
      lastEnrichedAt: Date.now(),
      error: ""
    },
    source: {
      pageUrl: input.source?.pageUrl || "",
      pageTitle: input.source?.pageTitle || "全站匹配",
      capturedAt: Date.now()
    }
  };
}

function cleanCreatorBio(value) {
  const text = String(value || "").trim();
  return isBoilerplateProfileText(text) ? "" : text;
}

function cleanEvidenceText(value) {
  return String(value || "")
    .split(/\r?\n|;\s*/)
    .map((line) => line.trim())
    .filter((line) => line && !isBoilerplateProfileText(line))
    .join("\n");
}

function isBoilerplateProfileText(text) {
  return /Browse your favorite items/i.test(text)
    || /TikTok Shop is now available/i.test(text)
    || /Visit TikTok to discover more trending creators/i.test(text)
    || /Skip to content|For You|Following|LIVE|Log in to follow creators/i.test(text);
}

function calculateFinalScore(matchScore, quality, extraPenalty = 0) {
  const riskPenalty = quality.fakeFollowerRisk === "high" ? 35 : quality.fakeFollowerRisk === "medium" ? 8 : 0;
  return clamp(Math.round(matchScore * 0.72 + quality.score * 0.28 - riskPenalty - extraPenalty), 0, 100);
}

function buildDiscoveryReasons(baseMatch, quality) {
  return [
    ...(baseMatch.reasons || []).slice(0, 2),
    quality.score >= 75 ? "质量评分通过" : "",
    quality.engagementRate ? `互动率 ${(quality.engagementRate * 100).toFixed(2)}%` : "",
    quality.fakeFollowerRisk === "low" ? "假粉风险低" : ""
  ].filter(Boolean);
}

function getFilteredReason(creator, filters) {
  if (creator.aiReview?.isPersonalCreator === false) return "疑似非个人创作者";
  if (creator.aiReview?.reject && (creator.aiReview?.semanticScore ?? 0) < 50) {
    return creator.aiReview.rejectReason || "AI复核不推荐";
  }
  if (creator.quality?.concerns?.some((concern) => concern.includes("品牌号"))) return "疑似品牌号";
  if (creator.quality?.concerns?.some((concern) => concern.includes("搬运") || concern.includes("商品"))) return "疑似聚合或商品号";
  if (creator.quality?.concerns?.some((concern) => concern.includes("无法验证创作者身份"))) return "信息不足";
  if (creator.quality?.concerns?.some((concern) => concern.includes("标题解析异常"))) return "信息不足";
  if (creator.discovery?.kind === "web-search" && !(creator.tags || []).length) return "低匹配度";
  if (!hasMinimumProfileEvidence(creator)) return "信息不足";
  if ((creator.match?.score || 0) < filters.minMatchScore) {
    return "低匹配度";
  }
  if (filters.minFollowers && creator.metrics?.followers == null) {
    if (creator.platform === "tiktok") return "";
    return "粉丝数未知";
  }
  if (filters.minFollowers && creator.metrics?.followers != null && Number(creator.metrics.followers) < filters.minFollowers) {
    return "粉丝数不足";
  }
  if ((creator.quality?.score || 0) < filters.minQualityScore) return "低质量";
  if (RISK_RANK[creator.quality?.fakeFollowerRisk || "high"] > RISK_RANK[filters.maxFakeFollowerRisk]) {
    return "疑似假粉或异常互动";
  }
  return "";
}

function hasMinimumProfileEvidence(creator) {
  if (creator.platform !== "tiktok" || creator.discovery?.kind !== "web-search") return true;

  const signals = [
    Boolean(creator.bio && creator.bio.length >= 20),
    Boolean(creator.avatarUrl),
    creator.metrics?.followers != null,
    (creator.tags || []).length >= 2,
    Boolean(creator.contact?.email)
  ].filter(Boolean).length;

  return signals >= MIN_TIKTOK_WEB_PROFILE_SIGNALS;
}

function isLikelyBrandAccount(creator, haystack) {
  const handle = String(creator.handle || "").toLowerCase();
  const name = String(creator.name || "").toLowerCase();
  const profileText = [handle, name].join(" ");
  const brandTerms = [
    "cosmetics",
    "beauty brand",
    "shop",
    "store",
    "mall",
    "news",
    "magazine",
    "products",
    "shopping"
  ];

  return handle.endsWith("_com")
    || brandTerms.some((term) => profileText.includes(term))
    || /\b(?:official|flagship)\s+(?:store|shop|brand)\b/i.test(haystack)
    || /(?:官方旗舰店|官方店铺|品牌官方)/.test(haystack);
}

function normalizeFilters(filters, brief = {}) {
  const briefMinFollowers = brief.followerRange?.min || 0;
  const minFollowers = filters.minFollowers || filters.minFollowerCount || briefMinFollowers || DEFAULT_FILTERS.minFollowers;
  return {
    ...DEFAULT_FILTERS,
    ...filters,
    minFollowers: Math.max(0, Number(minFollowers) || 0),
    maxFakeFollowerRisk: filters.maxFakeFollowerRisk || DEFAULT_FILTERS.maxFakeFollowerRisk
  };
}

function calculateDiscoveryFetchLimit(platform, requestedLimit) {
  if (platform === "tiktok") {
    return clamp(Math.max(requestedLimit * 5, TIKTOK_RAW_MIN_LIMIT), requestedLimit, TIKTOK_RAW_MAX_LIMIT);
  }
  return Math.max(requestedLimit * 3, 24);
}

function getUnknownFollowerPenalty(creator, filters) {
  if (!filters.minFollowers || creator.platform !== "tiktok") return 0;
  if (creator.metrics?.followers != null) return 0;
  return TIKTOK_UNKNOWN_FOLLOWER_PENALTY;
}

function applyPostProcessingScores(creators, feedbackSummary = {}) {
  return creators.map((creator) => {
    const feedbackBoost = calculateFeedbackBoost(creator, feedbackSummary);
    const score = calculateAiAdjustedScore(creator.score ?? creator.match?.score ?? 0, creator.aiReview, feedbackBoost);
    return {
      ...creator,
      score,
      match: {
        ...creator.match,
        score,
        dimensions: {
          ...(creator.match?.dimensions || {}),
          feedbackBoost
        }
      }
    };
  });
}

function calculateAiAdjustedScore(baseScore, aiReview, feedbackBoost = 0) {
  const reviewScores = [
    aiReview?.semanticScore,
    aiReview?.collaborationFit,
    aiReview?.evidenceConfidence
  ].filter((score) => score != null && Number.isFinite(Number(score))).map(Number);
  const aiScore = reviewScores.length
    ? Math.round(reviewScores.reduce((sum, score) => sum + score, 0) / reviewScores.length)
    : null;
  const personalPenalty = aiReview?.isPersonalCreator === false ? 18 : 0;
  const rejectPenalty = aiReview?.reject ? 22 : 0;
  const blended = aiScore == null
    ? Number(baseScore || 0)
    : Math.round(Number(baseScore || 0) * 0.58 + aiScore * 0.42);
  return clamp(blended + feedbackBoost - personalPenalty - rejectPenalty, 0, 100);
}

function calculateFeedbackBoost(creator, feedbackSummary = {}) {
  if (!feedbackSummary.total) return 0;

  const key = creatorKey(creator);
  let boost = 0;
  if (feedbackSummary.savedKeys?.has(key)) boost += 8;
  if (feedbackSummary.ignoredKeys?.has(key)) boost -= 12;
  if (feedbackSummary.removedKeys?.has(key)) boost -= 6;

  const tags = new Set((creator.tags || []).map((tag) => String(tag).toLowerCase()));
  const preferredHits = (feedbackSummary.preferredTags || []).filter((tag) => tags.has(String(tag).toLowerCase())).length;
  const rejectedHits = (feedbackSummary.rejectedTags || []).filter((tag) => tags.has(String(tag).toLowerCase())).length;
  boost += Math.min(preferredHits * 2, 6);
  boost -= Math.min(rejectedHits * 2, 6);

  return clamp(boost, -18, 14);
}

function summarizeFeedback(feedback, platform) {
  const items = Array.isArray(feedback?.items) ? feedback.items : Array.isArray(feedback) ? feedback : [];
  const scoped = items
    .filter((item) => !platform || !item.platform || item.platform === platform)
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
    .slice(0, 120);
  const savedItems = scoped.filter((item) => item.action === "saved" || item.action === "shortlisted");
  const ignoredItems = scoped.filter((item) => item.action === "ignored");
  const removedItems = scoped.filter((item) => item.action === "removed");

  return {
    total: scoped.length,
    saved: savedItems.length,
    ignored: ignoredItems.length,
    removed: removedItems.length,
    savedKeys: new Set(savedItems.map(creatorKey).filter(Boolean)),
    ignoredKeys: new Set(ignoredItems.map(creatorKey).filter(Boolean)),
    removedKeys: new Set(removedItems.map(creatorKey).filter(Boolean)),
    preferredTags: topTags(savedItems),
    rejectedTags: topTags([...ignoredItems, ...removedItems]),
    savedExamples: savedItems.slice(0, 5).map(compactFeedbackItem),
    ignoredExamples: ignoredItems.slice(0, 5).map(compactFeedbackItem)
  };
}

function serializeFeedbackSummary(feedbackSummary = {}) {
  return {
    total: feedbackSummary.total || 0,
    saved: feedbackSummary.saved || 0,
    ignored: feedbackSummary.ignored || 0,
    removed: feedbackSummary.removed || 0,
    preferredTags: feedbackSummary.preferredTags || [],
    rejectedTags: feedbackSummary.rejectedTags || [],
    savedExamples: feedbackSummary.savedExamples || [],
    ignoredExamples: feedbackSummary.ignoredExamples || []
  };
}

function compactFeedbackItem(item) {
  return {
    handle: item.handle || "",
    name: item.name || "",
    tags: (item.tags || []).slice(0, 5),
    score: item.score ?? null
  };
}

function topTags(items) {
  const counts = new Map();
  for (const item of items) {
    for (const tag of item.tags || []) {
      const key = String(tag || "").toLowerCase().trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([tag]) => tag);
}

function creatorKey(creator = {}) {
  return String(creator.id || creator.handle || creator.profileUrl || "").toLowerCase();
}

function dedupeCreators(creators) {
  const byId = new Map();
  for (const creator of creators) {
    if (!creator.id) continue;
    const previous = byId.get(creator.id);
    byId.set(creator.id, previous ? mergeCreator(previous, creator) : creator);
  }
  return [...byId.values()];
}

function mergeCreator(previous, next) {
  return {
    ...previous,
    ...next,
    metrics: { ...previous.metrics, ...next.metrics },
    tags: [...new Set([...(previous.tags || []), ...(next.tags || [])])],
    discovery: { ...previous.discovery, ...next.discovery }
  };
}

function countReasons(rejected) {
  return rejected.reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {});
}

function normalizePlatform(platform) {
  const normalized = String(platform || "x").toLowerCase();
  return normalized === "twitter" ? "x" : normalized;
}

function buildProfileUrl(platform, rawHandle) {
  if (!rawHandle) return "";
  if (platform === "tiktok") return `https://www.tiktok.com/@${rawHandle}`;
  return `https://x.com/${rawHandle}`;
}

function normalizeHandle(handle) {
  if (!handle) return "";
  const raw = String(handle).replace(/^@/, "").trim();
  return raw ? `@${raw}` : "";
}

function extractHandle(profileUrl = "") {
  try {
    const url = new URL(profileUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const match = host === "tiktok.com"
      ? url.pathname.match(/^\/@([A-Za-z0-9._]{2,24})(?:\/|$)/)
      : url.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    return match ? `@${match[1]}` : "";
  } catch {
    return "";
  }
}

function maxRisk(left, right) {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export const __testing = {
  applyPostProcessingScores,
  calculateAiAdjustedScore,
  calculateDiscoveryFetchLimit,
  calculateFinalScore,
  calculateFeedbackBoost,
  formatDuration,
  getFilteredReason,
  hasMinimumProfileEvidence,
  getUnknownFollowerPenalty,
  serializeFeedbackSummary,
  summarizeFeedback
};

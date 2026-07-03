const TIKTOK_RESERVED_PATHS = new Set([
  "about",
  "business",
  "channel",
  "discover",
  "download",
  "explore",
  "foryou",
  "legal",
  "login",
  "music",
  "search",
  "share",
  "tag",
  "trending",
  "upload",
  "video"
]);

const COUNTRY_SEARCH_TERMS = {
  US: ["United States", "US", "USA"],
  GB: ["United Kingdom", "UK", "Britain"],
  CA: ["Canada"],
  AU: ["Australia"],
  JP: ["Japan", "Japanese"],
  KR: ["Korea", "Korean"],
  SG: ["Singapore"],
  DE: ["Germany", "German"],
  FR: ["France", "French"],
  IT: ["Italy", "Italian"],
  ES: ["Spain", "Spanish"],
  BR: ["Brazil", "Brazilian"],
  MX: ["Mexico", "Mexican"],
  ID: ["Indonesia", "Indonesian"],
  TH: ["Thailand", "Thai"],
  VN: ["Vietnam", "Vietnamese"],
  PH: ["Philippines", "Filipino"],
  MY: ["Malaysia", "Malaysian"],
  IN: ["India", "Indian"]
};

const DEFAULT_QUERY_LIMIT = 16;
const DEFAULT_ENRICH_LIMIT = 40;
const DEFAULT_SOURCE_CONCURRENCY = 3;
const DEFAULT_QUERY_CONCURRENCY = 3;
const DEFAULT_ENRICH_CONCURRENCY = 8;
const DEFAULT_ENRICH_PROFILE_TIMEOUT_MS = 20_000;

export const tiktokProvider = {
  platform: "tiktok",
  get sourceName() {
    return process.env.KOL_DATA_API_URL ? "third-party-http" : "fallback-search";
  },

  buildSearchUrl(plan) {
    const params = new URLSearchParams({
      q: plan.query || "creator"
    });

    return `https://www.tiktok.com/search/user?${params.toString()}`;
  },

  buildProfileUrl(handle) {
    const normalized = normalizeTikTokHandle(handle);
    return normalized ? `https://www.tiktok.com/@${normalized}` : "";
  },

  async discoverCreators(plan, options = {}) {
    if (process.env.KOL_DATA_API_URL) {
      return discoverCreatorsFromHttp(plan, options);
    }

    return discoverCreatorsFromFallbackSearch(plan, options);
  },

  async enrich(creator, options = {}) {
    return enrichFromPublicProfile(creator, options.signal);
  }
};

async function discoverCreatorsFromHttp(plan, options) {
  const startedAt = Date.now();
  options.logger?.info("tiktok_http.start", {
    limit: options.limit || 50,
    hasApiKey: Boolean(process.env.KOL_DATA_API_KEY)
  });

  let response;
  try {
    response = await fetch(process.env.KOL_DATA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.KOL_DATA_API_KEY ? { Authorization: `Bearer ${process.env.KOL_DATA_API_KEY}` } : {})
      },
      body: JSON.stringify({
        platform: "tiktok",
        query: plan.query,
        keywords: plan.positiveTerms,
        excludeKeywords: plan.negativeTerms,
        filters: options.filters || {},
        limit: options.limit || 50
      }),
      signal: options.signal
    });
  } catch (error) {
    options.logger?.error("tiktok_http.error", {
      stageElapsedMs: Date.now() - startedAt,
      error
    });
    throw error;
  }

  if (!response.ok) {
    options.logger?.error("tiktok_http.error", {
      stageElapsedMs: Date.now() - startedAt,
      status: response.status
    });
    throw new Error(`三方 TikTok 数据源请求失败：${response.status}`);
  }

  const payload = await response.json();
  const creators = Array.isArray(payload.creators) ? payload.creators : payload.results || payload.data || [];
  options.logger?.info("tiktok_http.done", {
    stageElapsedMs: Date.now() - startedAt,
    status: response.status,
    creators: creators.length
  });
  return creators.map((creator) => ({
    ...creator,
    platform: "tiktok",
    sourceProvider: creator.sourceProvider || "third-party-http",
    discovery: {
      ...creator.discovery,
      sourceProvider: creator.discovery?.sourceProvider || creator.sourceProvider || "third-party-http"
    }
  }));
}

async function discoverCreatorsFromFallbackSearch(plan, options = {}) {
  const startedAt = Date.now();
  const logger = options.logger || null;
  const limit = options.limit || 50;
  const errors = [];
  const direct = new Map();

  for (const creator of buildDirectProfileCandidates(plan)) {
    mergeDiscoveredCreator(direct, creator);
  }

  const sources = buildSearchSources();
  const queryLimit = readPositiveInt(process.env.TIKTOK_SEARCH_QUERY_LIMIT, DEFAULT_QUERY_LIMIT);
  const enrichLimit = readPositiveInt(process.env.TIKTOK_ENRICH_LIMIT, DEFAULT_ENRICH_LIMIT);
  const sourceConcurrency = readPositiveInt(process.env.TIKTOK_SEARCH_SOURCE_CONCURRENCY, DEFAULT_SOURCE_CONCURRENCY);
  const queryConcurrency = readPositiveInt(process.env.TIKTOK_SEARCH_QUERY_CONCURRENCY, DEFAULT_QUERY_CONCURRENCY);
  const queries = buildSearchQueries(plan, options.filters || {}).slice(0, queryLimit);
  const configuredSourceNames = buildConfiguredSearchSourceNames();
  const found = new Map(direct);
  const diagnostics = {
    queryCount: queries.length,
    queries,
    configuredSources: configuredSourceNames,
    sourceConcurrency,
    queryConcurrency,
    sources: [],
    directProfiles: direct.size,
    rawFetched: direct.size,
    enriched: 0,
    errors
  };
  logger?.info("tiktok_fallback.start", {
    limit,
    queryCount: queries.length,
    sourceCount: sources.length,
    configuredSources: configuredSourceNames,
    sourceConcurrency,
    queryConcurrency,
    enrichLimit,
    directProfiles: direct.size
  });

  let sourceGroupIndex = 0;
  for (const sourceGroup of chunkArray(sources, sourceConcurrency)) {
    throwIfAborted(options.signal);
    const sourceGroupStartedAt = Date.now();
    logger?.info("tiktok_source_group.start", {
      groupIndex: sourceGroupIndex,
      sources: sourceGroup.map((source) => source.name),
      currentFound: found.size
    });
    const results = await Promise.all(sourceGroup.map((source) =>
      searchSourceForCreators(source, queries, plan, limit, queryConcurrency, options.signal, logger)
    ));

    for (const result of results) {
      const beforeSourceSize = found.size;
      for (const creator of result.creators) mergeDiscoveredCreator(found, creator);
      result.stats.newCandidates = Math.max(0, found.size - beforeSourceSize);
      if (!result.stats.newCandidates && !result.stats.errors.length) {
        errors.push(`${result.stats.source}:未返回候选`);
      }
      errors.push(...result.stats.errors);
      diagnostics.sources.push(result.stats);
    }

    logger?.info("tiktok_source_group.done", {
      stageElapsedMs: Date.now() - sourceGroupStartedAt,
      groupIndex: sourceGroupIndex,
      found: found.size,
      sourceStats: results.map((result) => ({
        source: result.stats.source,
        queriesTried: result.stats.queriesTried,
        rawResults: result.stats.rawResults,
        profileCandidates: result.stats.profileCandidates,
        parsedCandidates: result.stats.parsedCandidates,
        candidateFiltered: result.stats.candidateFiltered,
        negativeFiltered: result.stats.negativeFiltered,
        newCandidates: result.stats.newCandidates,
        errors: result.stats.errors.length
      }))
    });
    sourceGroupIndex += 1;

    if (found.size >= limit) break;
  }

  if (found.size) {
    const creators = rankSearchCandidates([...found.values()]).slice(0, limit);
    diagnostics.rawFetched = found.size;
    diagnostics.enriched = Math.min(creators.length, enrichLimit);
    diagnostics.enrichConcurrency = readPositiveInt(process.env.TIKTOK_ENRICH_CONCURRENCY, DEFAULT_ENRICH_CONCURRENCY);
    logger?.info("tiktok_fallback.raw_done", {
      stageElapsedMs: Date.now() - startedAt,
      found: found.size,
      selected: creators.length,
      enrichCount: diagnostics.enriched
    });
    const enriched = await enrichSearchCandidates(creators, diagnostics.enriched, options.signal, logger, options.onCandidate);
    logger?.info("tiktok_fallback.done", {
      stageElapsedMs: Date.now() - startedAt,
      returned: enriched.length,
      rawFetched: diagnostics.rawFetched,
      enriched: diagnostics.enriched,
      errors: errors.length
    });
    return attachDiscoveryMeta(enriched, diagnostics);
  }

  if (errors.length) {
    logger?.warn("tiktok_fallback.empty", {
      stageElapsedMs: Date.now() - startedAt,
      errors: errors.length,
      sourceCount: diagnostics.sources.length,
      rawResults: sumDiagnosticField(diagnostics, "rawResults"),
      profileCandidates: sumDiagnosticField(diagnostics, "profileCandidates"),
      parsedCandidates: sumDiagnosticField(diagnostics, "parsedCandidates"),
      candidateFiltered: sumDiagnosticField(diagnostics, "candidateFiltered"),
      negativeFiltered: sumDiagnosticField(diagnostics, "negativeFiltered")
    });
    throw createDiscoveryEmptyError(buildFallbackSearchFailureMessage(diagnostics, Date.now() - startedAt, errors));
  }

  logger?.warn("tiktok_fallback.empty", {
    stageElapsedMs: Date.now() - startedAt,
    errors: 0,
    sourceCount: diagnostics.sources.length,
    rawResults: sumDiagnosticField(diagnostics, "rawResults"),
    profileCandidates: sumDiagnosticField(diagnostics, "profileCandidates"),
    parsedCandidates: sumDiagnosticField(diagnostics, "parsedCandidates"),
    candidateFiltered: sumDiagnosticField(diagnostics, "candidateFiltered"),
    negativeFiltered: sumDiagnosticField(diagnostics, "negativeFiltered")
  });
  return [];
}

async function searchSourceForCreators(source, queries, plan, limit, queryConcurrency, signal, logger) {
  const startedAt = Date.now();
  const found = new Map();
  const stats = {
    source: source.name,
    queriesTried: 0,
    rawResults: 0,
    profileCandidates: 0,
    parsedCandidates: 0,
    candidateFiltered: 0,
    negativeFiltered: 0,
    newCandidates: 0,
    errors: []
  };
  logger?.info("tiktok_source.start", {
    source: source.name,
    queryCount: queries.length,
    queryConcurrency
  });

  let batchIndex = 0;
  for (const queryGroup of chunkArray(queries, queryConcurrency)) {
    throwIfAborted(signal);
    const batchStartedAt = Date.now();
    const results = await Promise.all(queryGroup.map(async (query) => {
      try {
        const pages = await source.search(query, signal);
        return { ok: true, query, pages };
      } catch (error) {
        return { ok: false, query, error };
      }
    }));

    for (const result of results) {
      stats.queriesTried += 1;
      if (!result.ok) {
        stats.errors.push(`${source.name}:${result.error.message}`);
        continue;
      }

      const creators = result.pages.flatMap((page) => parseSearchPage(page, result.query, plan, source.name, stats));
      for (const creator of creators) mergeDiscoveredCreator(found, creator);
    }

    logger?.info("tiktok_query_batch.done", {
      stageElapsedMs: Date.now() - batchStartedAt,
      source: source.name,
      batchIndex,
      queriesTried: results.length,
      ok: results.filter((result) => result.ok).length,
      errors: results.filter((result) => !result.ok).length,
      rawResults: stats.rawResults,
      profileCandidates: stats.profileCandidates,
      parsedCandidates: stats.parsedCandidates,
      candidateFiltered: stats.candidateFiltered,
      negativeFiltered: stats.negativeFiltered,
      uniqueCandidates: found.size,
      querySamples: shouldLogQueries() ? queryGroup : undefined
    });
    batchIndex += 1;

    if (found.size >= limit) break;
  }

  logger?.info("tiktok_source.done", {
    stageElapsedMs: Date.now() - startedAt,
    source: source.name,
    queriesTried: stats.queriesTried,
    rawResults: stats.rawResults,
    profileCandidates: stats.profileCandidates,
    parsedCandidates: stats.parsedCandidates,
    candidateFiltered: stats.candidateFiltered,
    negativeFiltered: stats.negativeFiltered,
    uniqueCandidates: found.size,
    errors: stats.errors.length
  });

  return {
    creators: [...found.values()],
    stats
  };
}

function buildSearchSources() {
  return [
    process.env.TAVILY_API_KEY ? { name: "tavily", search: fetchTavilySearchPages } : null,
    process.env.JINA_API_KEY ? { name: "jina-search", search: fetchJinaSearchPages } : null,
    process.env.SERPER_API_KEY ? { name: "serper", search: fetchSerperSearchPages } : null,
    process.env.BRAVE_SEARCH_API_KEY ? { name: "brave", search: fetchBraveSearchPages } : null,
    { name: "yahoo-web-search", search: fetchYahooSearchPages }
  ].filter(Boolean);
}

function buildConfiguredSearchSourceNames() {
  return [
    process.env.TAVILY_API_KEY ? "tavily" : "",
    process.env.JINA_API_KEY ? "jina-search" : "",
    process.env.SERPER_API_KEY ? "serper" : "",
    process.env.BRAVE_SEARCH_API_KEY ? "brave" : ""
  ].filter(Boolean);
}

function buildDirectProfileCandidates(plan) {
  return (plan.directProfiles || [])
    .map((handle) => normalizeTikTokProfile(`https://www.tiktok.com/@${String(handle).replace(/^@/, "")}`))
    .filter(Boolean)
    .map((profile) => buildSearchCandidate(profile, "direct profile", plan, profile.profileUrl, {
      url: profile.profileUrl,
      title: profile.handle,
      snippet: "direct profile"
    }))
    .filter(Boolean);
}

function buildSearchQueries(plan, filters = {}) {
  const rawText = plan.normalizedBrief?.rawText || plan.query || "";
  const positiveTerms = plan.positiveTerms || [];
  const expandedTerms = expandSearchTerms(rawText, positiveTerms);
  const negativeTerms = (plan.negativeTerms || []).map((term) => `-${term}`);
  const countryTerms = buildCountryTerms(filters.country).slice(0, 3);
  const countryQuery = countryTerms.join(" ");
  const compactTerms = unique([...positiveTerms, ...expandedTerms]).slice(0, 10);
  const hashtagTerms = buildHashtagTerms(expandedTerms).slice(0, 6);
  const directQuery = [compactTerms.length ? compactTerms.join(" ") : "creator", countryQuery].filter(Boolean).join(" ");
  const aiQueries = (plan.aiSearch?.queries || [])
    .slice(0, 8)
    .map((query) => buildAiSearchQuery(query, countryQuery, negativeTerms))
    .filter(Boolean);

  return unique([
    ...aiQueries,
    `site:tiktok.com/@ ${directQuery} ${negativeTerms.join(" ")}`,
    `site:www.tiktok.com/@ ${directQuery} ${negativeTerms.join(" ")}`,
    `site:tiktok.com/@ "${directQuery}" ${negativeTerms.join(" ")}`,
    `site:tiktok.com/@ creator ${expandedTerms.slice(0, 6).join(" ")} ${negativeTerms.join(" ")}`,
    `site:tiktok.com/@ influencer ${expandedTerms.slice(0, 6).join(" ")} ${negativeTerms.join(" ")}`,
    hashtagTerms.length ? `site:tiktok.com/@ ${hashtagTerms.join(" ")} creator ${countryQuery} ${negativeTerms.join(" ")}` : "",
    `site:tiktok.com/@ ${compactTerms.slice(0, 6).join(" ")} email ${negativeTerms.join(" ")}`,
    ...buildTopicQueries(rawText, negativeTerms, countryQuery)
  ])
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter((query) => query.length > "site:tiktok.com/@".length);
}

function buildTopicQueries(rawText, negativeTerms, countryQuery = "") {
  const negative = negativeTerms.join(" ");
  if (/coser|cosplay|cosplayer|二次元|角色扮演|\bcos\b/i.test(rawText)) {
    return [
      `site:tiktok.com/@ cosplay cosplayer ${countryQuery} ${negative}`,
      `site:tiktok.com/@ "#cosplay" "#cosplayer" ${countryQuery} ${negative}`,
      `site:tiktok.com/@ coser cosplay anime ${countryQuery} ${negative}`,
      `site:tiktok.com/@ "cosplay creator" ${countryQuery} ${negative}`,
      `site:www.tiktok.com/@ cosplay cosplayer anime ${countryQuery} ${negative}`
    ];
  }
  return [];
}

function buildCountryTerms(countryCode) {
  return COUNTRY_SEARCH_TERMS[String(countryCode || "").toUpperCase()] || [];
}

async function fetchYahooSearchPages(query, signal) {
  const errors = [];
  const hosts = ["search.yahoo.com", "search.yahoo.co.jp"];
  const pages = [];

  for (const host of hosts) {
    const url = new URL(`https://${host}/search`);
    url.searchParams.set("p", query);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "text/html"
        },
        signal: createTimeoutSignal(8000, signal)
      });

      const html = await response.text();
      if (response.ok && html) {
        pages.push(html);
        continue;
      }
      errors.push(`${host}:${response.status}`);
    } catch (error) {
      errors.push(`${host}:${error.message}`);
    }
  }

  const markdown = await fetchYahooSearchMarkdown(query, signal).catch((error) => {
    errors.push(`jina-yahoo:${error.message}`);
    return "";
  });
  if (markdown) pages.push(markdown);

  if (pages.length) return pages;

  throw new Error(`Yahoo Search 请求失败：${errors.join(" / ")}`);
}

async function fetchSerperSearchPages(query, signal) {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.SERPER_API_KEY
    },
    body: JSON.stringify({ q: query, num: 10 }),
    signal: createTimeoutSignal(10000, signal)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Serper 请求失败：${response.status}`);

  return [{
    kind: "json-results",
    sourceProvider: "serper",
    results: [
      ...(payload.organic || []),
      ...(payload.peopleAlsoAsk || [])
    ].map((item) => ({
      url: item.link || item.url || "",
      title: item.title || item.question || "",
      snippet: item.snippet || item.answer || "",
      imageUrl: item.imageUrl || item.thumbnailUrl || "",
      relevanceScore: item.position ? Math.max(0.5, 1 - (item.position - 1) * 0.04) : null
    }))
  }];
}

async function fetchTavilySearchPages(query, signal) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 10,
      include_answer: false,
      include_images: true
    }),
    signal: createTimeoutSignal(12000, signal)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `Tavily 请求失败：${response.status}`);

  return [{
    kind: "json-results",
    sourceProvider: "tavily",
    results: (payload.results || []).map((item) => ({
      url: item.url || "",
      title: item.title || "",
      snippet: item.content || item.snippet || "",
      imageUrl: item.image_url || item.imageUrl || "",
      relevanceScore: item.score ?? null
    }))
  }];
}

async function fetchBraveSearchPages(query, signal) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY
    },
    signal: createTimeoutSignal(10000, signal)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.detail || payload.message || `Brave 请求失败：${response.status}`);

  return [{
    kind: "json-results",
    sourceProvider: "brave",
    results: (payload.web?.results || []).map((item) => ({
      url: item.url || "",
      title: item.title || "",
      snippet: item.description || "",
      imageUrl: item.thumbnail?.src || item.profile?.img || "",
      relevanceScore: item.age ? 0.7 : null
    }))
  }];
}

async function fetchJinaSearchPages(query, signal) {
  const url = new URL("https://s.jina.ai/");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: {
      Accept: "text/plain",
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
      "User-Agent": "Mozilla/5.0"
    },
    signal: createTimeoutSignal(12000, signal)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Jina Search 请求失败：${response.status}`);
  return [text];
}

async function fetchYahooSearchMarkdown(query, signal) {
  const yahooUrl = `http://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  const url = `https://r.jina.ai/${yahooUrl}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/plain"
    },
    signal: createTimeoutSignal(10000, signal)
  });

  const text = await response.text();
  if (!response.ok || !text.includes("Search Results")) {
    throw new Error(`Jina Yahoo 请求失败：${response.status}`);
  }

  return text;
}

function parseSearchPage(page, query, plan, sourceProvider, stats) {
  const results = typeof page === "string" ? extractYahooResults(page) : normalizeSearchResults(page);
  stats && (stats.rawResults += results.length);

  const creators = [];
  for (const result of results) {
    const profile = normalizeTikTokProfile(result.url);
    if (!profile) continue;
    stats && (stats.profileCandidates += 1);

    const creator = buildSearchCandidate(profile, query, plan, result.sourceUrl || result.url, {
      ...result,
      sourceProvider
    });
    if (!creator) {
      stats && (stats.candidateFiltered += 1);
      continue;
    }
    if (!matchesNegativeTerms(creator, plan.negativeTerms || [])) {
      stats && (stats.negativeFiltered += 1);
      continue;
    }

    stats && (stats.parsedCandidates += 1);
    creators.push(creator);
  }

  return creators;
}

function normalizeSearchResults(page = {}) {
  return (page.results || []).map((result) => ({
    ...result,
    sourceProvider: result.sourceProvider || page.sourceProvider || "search-api"
  }));
}

function extractYahooResults(html) {
  const results = [];
  const decodedHtml = decodeHtmlEntities(String(html || ""));

  results.push(...extractMarkdownSearchResults(decodedHtml));

  for (const match of decodedHtml.matchAll(/<li\b[^>]*class="[^"]*\balgo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = match[1];
    const redirect = block.match(/href="(https?:\/\/r\.search\.yahoo\.com\/[^"]+)"/i)?.[1];
    const targetUrl = redirect ? decodeYahooRedirect(redirect) : "";
    const profile = normalizeTikTokProfile(targetUrl) || extractTikTokProfileFromText(block);
    if (!profile) continue;

    results.push({
      url: profile.profileUrl,
      title: cleanHtmlText(block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || ""),
      snippet: cleanHtmlText(block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || ""),
      imageUrl: extractSearchResultImage(block),
      sourceUrl: targetUrl || profile.sourceUrl
    });
  }

  for (const match of decodedHtml.matchAll(/https?:\/\/(?:www\.)?tiktok\.com\/(?:@|%40)\/?[A-Za-z0-9._]{2,24}(?:[/?#][^"'<>\s]*)?/gi)) {
    results.push({ url: match[0], title: "", snippet: "" });
  }

  for (const block of decodedHtml.matchAll(/TikTok\s+https?:\/\/(?:www\.)?tiktok\.com\s*›\s*@\s*›\s*([A-Za-z0-9._]{2,24})/gi)) {
    const handle = normalizeTikTokHandle(block[1]);
    if (!handle) continue;
    results.push({
      url: `https://www.tiktok.com/@${handle}`,
      title: `@${handle}`,
      snippet: cleanHtmlText(block[0])
    });
  }

  const byUrl = new Map();
  for (const result of results) {
    const profile = normalizeTikTokProfile(result.url);
    if (!profile) continue;
    if (!byUrl.has(profile.profileUrl)) {
      byUrl.set(profile.profileUrl, { ...result, url: result.url });
      continue;
    }

    const previous = byUrl.get(profile.profileUrl);
    byUrl.set(profile.profileUrl, {
      ...previous,
      title: previous.title || result.title,
      snippet: previous.snippet || result.snippet,
      imageUrl: previous.imageUrl || result.imageUrl
    });
  }

  return [...byUrl.values()];
}

function extractMarkdownSearchResults(markdown) {
  const results = [];

  for (const line of String(markdown || "").split("\n")) {
    if (!/^\s*\d+\.\s+/.test(line)) continue;
    const text = cleanMarkdownText(line);
    const handle = extractTikTokHandleFromText(text);
    if (!handle) continue;

    results.push({
      url: `https://www.tiktok.com/@${handle}`,
      title: text.split(" - ")[0] || `@${handle}`,
      snippet: text
    });
  }

  return results;
}

function normalizeTikTokProfile(targetUrl) {
  try {
    const url = new URL(decodeHtmlEntities(String(targetUrl || "")));
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "tiktok.com" && host !== "m.tiktok.com") return null;

    const pathname = decodeURIComponent(url.pathname);
    const match = pathname.match(/^\/(?:@|%40)\/?([A-Za-z0-9._]{2,24})(?:\/|$)/);
    const rawHandle = normalizeTikTokHandle(match?.[1] || "");
    if (!rawHandle) return null;

    return {
      rawHandle,
      handle: `@${rawHandle}`,
      profileUrl: `https://www.tiktok.com/@${rawHandle}`,
      sourceUrl: url.toString()
    };
  } catch {
    return null;
  }
}

function extractTikTokProfileFromText(text) {
  const handle = extractTikTokHandleFromText(cleanHtmlText(text));
  return handle ? normalizeTikTokProfile(`https://www.tiktok.com/@${handle}`) : null;
}

function extractSearchResultImage(block) {
  for (const match of String(block || "").matchAll(/<img\b[^>]+(?:src|data-src)=["']([^"']+)["']/gi)) {
    const imageUrl = decodeHtmlEntities(match[1]);
    if (isUsefulThumbnail(imageUrl)) return imageUrl;
  }
  return "";
}

function isUsefulThumbnail(imageUrl) {
  const url = String(imageUrl || "");
  return /^https?:\/\//i.test(url)
    && !/favicon|sprite|logo|icon/i.test(url)
    && !/\/(?:16|32|40)x(?:16|32|40)_/i.test(url);
}

function normalizeImageUrl(imageUrl) {
  const url = String(imageUrl || "");
  return isUsefulThumbnail(url) ? url : "";
}

function buildSearchCandidate(profile, query, plan, sourceUrl, result = {}) {
  if (isNoisySearchResult(result)) return null;

  const terms = expandSearchTerms(plan.normalizedBrief?.rawText || plan.query || "", plan.positiveTerms || []);
  const queryText = query === "direct profile" ? plan.normalizedBrief?.rawText || "" : query;
  const observedText = [result.title, result.snippet, profile.rawHandle].filter(Boolean).join(" ");
  const observedTerms = selectObservedTerms(observedText, terms);
  const queryTerms = selectObservedTerms(queryText, terms);
  const strictTopic = requiresStrictTopic(plan);
  if (strictTopic && !hasStrictTopicEvidence(observedText, profile.rawHandle)) return null;
  const name = cleanProfileTitle(result.title, profile.rawHandle);
  const bio = buildSearchResultBio(result.snippet, profile.rawHandle);

  const evidenceText = [
    result.title ? `title: ${result.title}` : "",
    result.snippet ? `snippet: ${result.snippet}` : "",
    result.sourceProvider ? `sourceProvider: ${result.sourceProvider}` : "",
    `matchedUrl: ${sourceUrl}`,
    observedTerms.length ? `matchedTerms: ${observedTerms.join(" ")}` : ""
  ].filter(Boolean).join("; ");
  const isDirectProfile = query === "direct profile";

  return {
    platform: "tiktok",
    name,
    handle: profile.handle,
    profileUrl: profile.profileUrl,
    avatarUrl: normalizeImageUrl(result.imageUrl),
    relevanceScore: normalizeRelevanceScore(result.relevanceScore),
    bio,
    contact: buildContactFromText([result.title, result.snippet].filter(Boolean).join(" ")),
    metrics: {
      followers: inferFollowersFromEvidence({ discovery: { evidenceText: [result.title, result.snippet].filter(Boolean).join(" ") } }),
      following: null,
      posts: null,
      avgEngagement: null
    },
    tags: observedTerms.slice(0, 12),
    sourceProvider: result.sourceProvider || "multi-search",
    discovery: {
      kind: isDirectProfile ? "profile" : "web-search",
      confidence: isDirectProfile ? 82 : 70,
      summary: isDirectProfile
        ? "用户输入中包含该 TikTok 主页，已尝试读取公开主页资料。"
        : `${result.sourceProvider || "Multi Search"} 真实搜索命中该 TikTok 账号，已尝试读取公开主页资料。`,
      evidenceText,
      needsEnrichment: true,
      relevanceScore: normalizeRelevanceScore(result.relevanceScore),
      sourceProvider: result.sourceProvider || "multi-search"
    },
    enrichment: {
      status: "partial",
      provider: result.sourceProvider || "multi-search"
    },
    source: {
      pageUrl: sourceUrl,
      pageTitle: "Yahoo Search",
      capturedAt: Date.now()
    }
  };
}

function normalizeRelevanceScore(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric <= 1 ? Math.round(numeric * 100) : Math.round(numeric)));
}

async function enrichSearchCandidates(creators, maxEnrichCount, signal, logger, onCandidate) {
  const head = creators.slice(0, maxEnrichCount);
  const tail = creators.slice(maxEnrichCount);
  const concurrency = readPositiveInt(process.env.TIKTOK_ENRICH_CONCURRENCY, DEFAULT_ENRICH_CONCURRENCY);
  const profileTimeoutMs = readPositiveInt(process.env.TIKTOK_ENRICH_PROFILE_TIMEOUT_MS, DEFAULT_ENRICH_PROFILE_TIMEOUT_MS);
  const startedAt = Date.now();
  let completed = 0;
  let failed = 0;
  logger?.info("tiktok_enrich.start", {
    candidates: creators.length,
    enrichCount: head.length,
    tailCount: tail.length,
    concurrency,
    profileTimeoutMs
  });
  const enriched = await mapWithConcurrency(head, concurrency, async (creator, index) => {
    const itemStartedAt = Date.now();
    let nextCreator = creator;
    try {
      const itemSignal = createTimeoutSignal(profileTimeoutMs, signal);
      nextCreator = await withTimeout(
        enrichFromPublicProfile(creator, itemSignal),
        profileTimeoutMs + 500,
        `TikTok 资料补全超过 ${formatElapsedDuration(profileTimeoutMs)}`
      );
    } catch (error) {
      failed += 1;
      logger?.warn("tiktok_enrich.item_failed", {
        index,
        handle: creator.handle || "",
        profileUrl: creator.profileUrl || "",
        stageElapsedMs: Date.now() - itemStartedAt,
        error
      });
      nextCreator = {
        ...creator,
        enrichment: {
          ...creator.enrichment,
          status: creator.enrichment?.status || "partial",
          error: error.message || "资料补全失败"
        }
      };
    } finally {
      completed += 1;
      if (onCandidate) {
        await Promise.resolve(onCandidate(nextCreator, {
          index,
          completed,
          total: head.length,
          failed
        })).catch(() => null);
      }
      if (completed === head.length || completed % concurrency === 0) {
        logger?.info("tiktok_enrich.progress", {
          stageElapsedMs: Date.now() - startedAt,
          completed,
          total: head.length,
          failed
        });
      }
    }
    return nextCreator;
  });
  logger?.info("tiktok_enrich.done", {
    stageElapsedMs: Date.now() - startedAt,
    enriched: enriched.length,
    returned: enriched.length + tail.length,
    failed
  });
  return [...enriched, ...tail];
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message || "操作超时")), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function enrichFromPublicProfile(creator, signal) {
  if (!creator.profileUrl) return creator;

  let profile = {};

  try {
    const response = await fetch(creator.profileUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      },
      signal: createTimeoutSignal(5000, signal)
    });

    if (response.ok) {
      const html = await response.text();
      profile = parsePublicTikTokProfile(html, creator.handle);
    }
  } catch {
    profile = {};
  }

  if (!hasUsefulProfileData(profile)) {
    const readerProfile = await fetchJinaReaderProfile(creator, signal).catch(() => ({}));
    profile = mergeProfileData(profile, readerProfile);
  }

  if (!hasProfileData(profile)) return creator;

  const evidenceText = unique([
    creator.discovery?.evidenceText,
    profile.bio ? `profileBio: ${profile.bio}` : "",
    profile.followers ? `${profile.followers} followers` : "",
    profile.contact?.email ? `email: ${profile.contact.email}` : ""
  ]).join("\n");

  return {
    ...creator,
    name: selectBestDisplayName(profile.name, creator.name, creator.handle),
    avatarUrl: profile.avatarUrl || creator.avatarUrl,
    bio: profile.bio || creator.bio,
    contact: mergeContact(creator.contact, profile.contact),
    metrics: {
      ...creator.metrics,
      followers: profile.followers ?? creator.metrics?.followers ?? inferFollowersFromEvidence({ discovery: { evidenceText } })
    },
    discovery: {
      ...creator.discovery,
      evidenceText,
      needsEnrichment: !(profile.bio && (profile.followers || creator.metrics?.followers))
    },
    enrichment: {
      ...creator.enrichment,
      status: profile.bio || profile.followers || profile.contact?.email ? "ready" : creator.enrichment?.status || "partial",
      provider: profile.provider || "tiktok-public-profile"
    }
  };
}

function hasProfileData(profile = {}) {
  return Boolean(profile.bio || profile.avatarUrl || profile.name || profile.followers || profile.contact?.email);
}

function hasUsefulProfileData(profile = {}) {
  return Boolean(profile.bio || profile.avatarUrl || profile.followers || profile.contact?.email);
}

function mergeProfileData(left = {}, right = {}) {
  return {
    ...left,
    ...right,
    name: right.name || left.name,
    bio: right.bio || left.bio,
    avatarUrl: right.avatarUrl || left.avatarUrl,
    followers: right.followers ?? left.followers,
    contact: mergeContact(left.contact, right.contact),
    provider: right.provider || left.provider
  };
}

async function fetchJinaReaderProfile(creator, signal) {
  if (!creator.profileUrl) return {};

  const response = await fetch(`https://r.jina.ai/${creator.profileUrl}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/plain",
      ...(process.env.JINA_API_KEY ? { Authorization: `Bearer ${process.env.JINA_API_KEY}` } : {})
    },
    signal: createTimeoutSignal(12000, signal)
  });
  const markdown = await response.text();
  if (!response.ok || !markdown) return {};

  return parseJinaReaderProfile(markdown, creator.handle);
}

function parseJinaReaderProfile(markdown, handle) {
  const title = String(markdown || "").match(/^Title:\s*(.+)$/m)?.[1] || "";
  const text = cleanMarkdownProfileText(markdown);
  const bio = extractJinaProfileBio(markdown);

  return {
    name: cleanProfileTitle(title, String(handle || "").replace(/^@/, "")),
    bio,
    avatarUrl: extractJinaProfileAvatar(markdown),
    followers: inferFollowersFromText(text),
    contact: buildContactFromText(`${bio} ${text}`),
    provider: "jina-reader"
  };
}

function extractJinaProfileAvatar(markdown) {
  for (const match of String(markdown || "").matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g)) {
    const imageUrl = decodeHtmlEntities(match[1]);
    if (isLikelyTikTokAvatar(imageUrl)) return imageUrl;
  }
  return "";
}

function isLikelyTikTokAvatar(imageUrl) {
  const url = String(imageUrl || "");
  return /^https?:\/\//i.test(url)
    && /tiktok/i.test(url)
    && /(?:avt|avatar|cropcenter:\d+:\d+)/i.test(url)
    && !/logo|sprite|icon|api\/img|tiktok_web_pages/i.test(url);
}

function normalizeProfileAvatarUrl(imageUrl) {
  const url = decodeHtmlEntities(String(imageUrl || ""));
  if (!url) return "";
  if (isLikelyTikTokAvatar(url)) return url;
  return isUsefulThumbnail(url) ? url : "";
}

function extractJinaProfileBio(markdown) {
  const lines = String(markdown || "")
    .split("\n")
    .map((line) => cleanMarkdownProfileText(line))
    .filter(Boolean);
  return lines.find((line) => line.length >= 20 && line.length <= 180 && !isTikTokBoilerplateText(line)) || "";
}

function isTikTokBoilerplateText(text) {
  const cleaned = cleanHtmlText(text);
  const normalized = cleaned
    .replace(/^tiktok\s*[-·|:]\s*/i, "")
    .replace(/\s*[-·|:]\s*tiktok$/i, "")
    .trim()
    .toLowerCase();

  return normalized === "make your day"
    || /^(?:\d+\.\s*)?(Title:|URL Source:|Markdown Content:|TikTok$|TikTok Search$|TikTok Shop|Company|Program|Terms|Policies|©|Followers$|Following$|Likes$)/i.test(cleaned)
    || /Browse your favorite items/i.test(text)
    || /Visit TikTok to discover more trending creators/i.test(text)
    || /Skip to content|For You|Following|LIVE|Log in to follow creators/i.test(text)
    || /About Newsroom Contact Careers/i.test(text)
    || /ByteDance TikTok for Good Advertise Developers/i.test(text);
}

function cleanMarkdownProfileText(text) {
  return cleanHtmlText(String(text || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]+/g, " ")
    .replace(/([KMB万亿千])\s*(Followers|fans|粉丝|关注者)/gi, "$1 $2"));
}

function parsePublicTikTokProfile(html, handle) {
  const title = getMetaContent(html, "og:title") || getTagContent(html, "title");
  const description = getMetaContent(html, "description") || getMetaContent(html, "og:description");
  const image = getMetaContent(html, "og:image");
  const cleanDescription = cleanProfileBio(description);
  const titleText = cleanHtmlText(title);
  const text = cleanHtmlText(`${titleText} ${cleanDescription} ${html}`);
  const metaProfile = {
    name: cleanProfileTitle(title, String(handle || "").replace(/^@/, "")),
    bio: cleanDescription,
    avatarUrl: normalizeProfileAvatarUrl(image),
    followers: inferFollowersFromText(text),
    contact: buildContactFromText(text),
    provider: "tiktok-meta-profile"
  };
  const embeddedProfile = parseTikTokEmbeddedProfile(html, handle);

  return mergeProfileData(metaProfile, embeddedProfile);
}

function parseTikTokEmbeddedProfile(html, handle) {
  const rawHandle = String(handle || "").replace(/^@/, "");
  for (const payload of extractJsonPayloads(html)) {
    const profile = findEmbeddedTikTokProfile(payload, rawHandle);
    if (hasProfileData(profile)) return profile;
  }
  return {};
}

function extractJsonPayloads(html) {
  const payloads = [];
  for (const match of String(html || "").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] || "";
    const content = decodeHtmlEntities(match[2] || "").trim();
    if (!content) continue;
    if (!/type=["']application\/json["']|id=["'](?:SIGI_STATE|__UNIVERSAL_DATA_FOR_REHYDRATION__)["']/i.test(attrs) && !content.startsWith("{")) {
      continue;
    }
    try {
      payloads.push(JSON.parse(content));
    } catch {
      // Ignore non-JSON scripts; TikTok changes script payloads frequently.
    }
  }
  return payloads;
}

function findEmbeddedTikTokProfile(payload, rawHandle) {
  const direct = profileFromUserModule(payload?.UserModule, rawHandle);
  if (hasProfileData(direct)) return direct;

  return findUserInfoProfile(payload, rawHandle) || {};
}

function profileFromUserModule(userModule, rawHandle) {
  const users = userModule?.users || {};
  const stats = userModule?.stats || {};
  const user = findMatchingUser(Object.values(users), rawHandle);
  if (!user) return {};

  const userKey = Object.entries(users).find(([, value]) => value === user)?.[0] || rawHandle;
  const stat = stats[userKey] || stats[user.id] || stats[user.secUid] || {};
  return buildEmbeddedProfile(user, stat, rawHandle);
}

function findUserInfoProfile(value, rawHandle, seen = new Set()) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const userInfo = value.userInfo || value.user || null;
  if (userInfo?.user && userInfo?.stats && isMatchingUser(userInfo.user, rawHandle)) {
    return buildEmbeddedProfile(userInfo.user, userInfo.stats, rawHandle);
  }
  if (value.user && value.stats && isMatchingUser(value.user, rawHandle)) {
    return buildEmbeddedProfile(value.user, value.stats, rawHandle);
  }

  for (const item of Object.values(value)) {
    const profile = findUserInfoProfile(item, rawHandle, seen);
    if (profile) return profile;
  }
  return null;
}

function findMatchingUser(users, rawHandle) {
  return users.find((user) => isMatchingUser(user, rawHandle));
}

function isMatchingUser(user, rawHandle) {
  const expected = String(rawHandle || "").replace(/^@/, "").toLowerCase();
  if (!expected || !user || typeof user !== "object") return false;
  return [
    user.uniqueId,
    user.uniqueID,
    user.handle,
    user.username,
    user.nickName,
    user.nickname
  ].some((value) => String(value || "").replace(/^@/, "").toLowerCase() === expected);
}

function buildEmbeddedProfile(user = {}, stats = {}, rawHandle = "") {
  const bio = cleanProfileBio(user.signature || user.bio || user.desc || "");
  const avatarUrl = [
    user.avatarLarger,
    user.avatarMedium,
    user.avatarThumb,
    user.avatarUrl,
    user.avatar
  ].map(normalizeProfileAvatarUrl).find(Boolean) || "";
  const followers = normalizeNumber(stats.followerCount ?? stats.followers ?? stats.fans ?? user.followerCount);

  return {
    name: cleanProfileTitle(user.nickname || user.nickName || user.displayName || user.uniqueId, rawHandle),
    bio,
    avatarUrl,
    followers,
    contact: buildContactFromText(`${bio} ${user.email || ""}`),
    provider: "tiktok-embedded-profile"
  };
}

function cleanProfileBio(value) {
  const text = cleanHtmlText(value);
  return text && !isTikTokBoilerplateText(text) ? text : "";
}

function expandSearchTerms(rawText, terms = []) {
  const haystack = `${rawText} ${terms.join(" ")}`.toLowerCase();
  const expanded = [...terms];

  if (/美妆|beauty|makeup|护肤|skincare/.test(haystack)) {
    expanded.push("beauty", "makeup", "skincare", "beauty creator");
  }
  if (/亚洲|asian/.test(haystack)) expanded.push("asian");
  if (/女|女性|woman|women|female/.test(haystack)) expanded.push("female", "woman");
  if (/coser|cosplay|cosplayer|二次元|角色扮演|\bcos\b/i.test(haystack)) {
    expanded.push("coser", "cosplay", "cosplayer", "anime");
  }
  if (/博主|达人|creator|influencer|kol/.test(haystack)) {
    expanded.push("creator", "influencer");
  }
  if (/教程|tutorial|how to/.test(haystack)) expanded.push("tutorial");
  if (/测评|评测|review/.test(haystack)) expanded.push("review");

  return unique(expanded).filter((term) => !/^-/.test(term));
}

function buildHashtagTerms(terms = []) {
  return unique(terms)
    .map((term) => String(term || "").toLowerCase().replace(/[^a-z0-9_]/g, ""))
    .filter((term) => term.length >= 3 && !/creator|influencer|female|woman/.test(term))
    .map((term) => `#${term}`);
}

function buildAiSearchQuery(query, countryQuery, negativeTerms) {
  const cleaned = String(query || "")
    .replace(/site:(?:x|twitter)\.com\/?\S*/gi, "")
    .replace(/site:(?:www\.)?tiktok\.com\/@/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return `site:tiktok.com/@ ${cleaned} ${countryQuery} ${negativeTerms.join(" ")}`.replace(/\s+/g, " ").trim();
}

function requiresStrictTopic(plan) {
  const text = `${plan.normalizedBrief?.rawText || ""} ${(plan.positiveTerms || []).join(" ")}`.toLowerCase();
  return /coser|cosplay|cosplayer|二次元|角色扮演|\bcos\b/i.test(text);
}

function hasStrictTopicEvidence(text, handle) {
  const haystack = `${text || ""} ${handle || ""}`.toLowerCase();
  return /(?:^|[^a-z0-9])(?:cosplay|cosplayer|coser|anime|manga|otaku|costume|comic\s*con|comiket|二次元|角色扮演)(?:[^a-z0-9]|$)/i.test(haystack)
    || /#[a-z0-9_]*(?:cosplay|cosplayer|coser|anime|manga|otaku)[a-z0-9_]*/i.test(haystack)
    || /(?:^|[^a-z0-9])cos(?:[^a-z0-9]|$)/i.test(haystack)
    || /(?:^|[^a-z0-9])cos_?[a-z0-9_]*$/i.test(String(handle || "").toLowerCase());
}

function matchesNegativeTerms(creator, negativeTerms) {
  const haystack = [
    creator.name,
    creator.handle,
    creator.bio,
    getObservedEvidenceText(creator.discovery?.evidenceText),
    ...(creator.tags || [])
  ].join(" ").toLowerCase();

  return !negativeTerms.some((term) => matchesNegativeTerm(haystack, term));
}

function getObservedEvidenceText(evidenceText = "") {
  return String(evidenceText || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !/^searchQuery:/i.test(part) && !/^queryTerms:/i.test(part))
    .join("; ");
}

function matchesNegativeTerm(haystack, term) {
  const normalized = String(term || "").replace(/^-+/, "").trim().toLowerCase();
  if (!normalized) return false;
  if (/[\u4e00-\u9fff]/.test(normalized)) return haystack.includes(normalized);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`, "i").test(haystack);
}

function normalizeTikTokHandle(handle) {
  const raw = String(handle || "").replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9._]{2,24}$/.test(raw)) return "";
  if (/^\.+$/.test(raw) || raw.startsWith(".") || raw.endsWith(".") || raw.includes("..")) return "";
  if (TIKTOK_RESERVED_PATHS.has(raw.toLowerCase())) return "";
  return raw;
}

function extractTikTokHandleFromText(text) {
  const raw = String(text || "");
  const breadcrumbHandle = raw.match(/tiktok\.com\s*(?:›|>|\/)\s*@\s*(?:›|>|\/)\s*([A-Za-z0-9._]{2,24})/i)?.[1];
  if (normalizeTikTokHandle(breadcrumbHandle)) return normalizeTikTokHandle(breadcrumbHandle);

  const urlHandle = raw.match(/tiktok\.com\/@([A-Za-z0-9._]{2,24})(?:[/?#]|\s|$)/i)?.[1];
  if (normalizeTikTokHandle(urlHandle)) return normalizeTikTokHandle(urlHandle);

  const atHandle = raw.match(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9._]{2,24})(?!\.)/)?.[2];
  return normalizeTikTokHandle(atHandle);
}

function inferFollowersFromEvidence(creator) {
  return inferFollowersFromText(creator.discovery?.evidenceText || creator.bio || "");
}

function inferFollowersFromText(text) {
  const raw = String(text || "");
  const patterns = [
    /([\d,.]+)\s*([KMB万亿千]?)\s*(?:followers|fans|粉丝|关注者)/i,
    /(?:followers|fans|粉丝|关注者)\s*[:：]?\s*([\d,.]+)\s*([KMB万亿千]?)/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return normalizeNumber(`${match[1]}${match[2] || ""}`);
  }
  return null;
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

function buildContactFromText(text) {
  const email = extractEmail(text);
  return {
    email,
    source: email ? "public-profile" : "",
    available: Boolean(email)
  };
}

function mergeContact(left = {}, right = {}) {
  const email = right.email || left.email || "";
  return {
    ...left,
    ...right,
    email,
    available: Boolean(email),
    source: right.email ? right.source || "public-profile" : left.source || ""
  };
}

function extractEmail(text) {
  const match = String(text || "")
    .replace(/\s*(?:\[at]|\(at\)| at )\s*/gi, "@")
    .replace(/\s*(?:\[dot]|\(dot\)| dot )\s*/gi, ".")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] || "";
}

function selectObservedTerms(text, terms) {
  const haystack = String(text || "").toLowerCase();
  const observed = terms.filter((term) => {
    const normalized = String(term || "").toLowerCase();
    if (!normalized) return false;
    if (/[\u4e00-\u9fff]/.test(normalized)) return haystack.includes(normalized);
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`, "i").test(haystack);
  });

  return unique(observed);
}

function mergeDiscoveredCreator(found, creator) {
  const key = String(creator.handle || creator.profileUrl || "").toLowerCase();
  if (!key) return;
  const previous = found.get(key);
  if (!previous) {
    found.set(key, creator);
    return;
  }

  found.set(key, {
    ...previous,
    ...creator,
    tags: unique([...(previous.tags || []), ...(creator.tags || [])]),
    discovery: {
      ...previous.discovery,
      ...creator.discovery,
      evidenceText: unique([
        previous.discovery?.evidenceText,
        creator.discovery?.evidenceText
      ]).join("\n")
    }
  });
}

function isNoisySearchResult(result = {}) {
  const text = [result.title, result.snippet].join(" ");
  if (/!\[image/i.test(text)) return true;
  if (/^tiktok\s+https?:/i.test(text)) return true;
  if (!cleanHtmlText(text) && !result.url) return true;
  return false;
}

function rankSearchCandidates(creators) {
  return [...creators].sort((left, right) => candidatePriority(right) - candidatePriority(left));
}

function candidatePriority(creator) {
  const relevance = Number(creator.relevanceScore ?? creator.discovery?.relevanceScore ?? 0);
  const tagScore = Math.min((creator.tags || []).length * 4, 24);
  const followerScore = creator.metrics?.followers ? 12 : 0;
  const profileScore = creator.discovery?.kind === "profile" ? 8 : 0;
  const contactScore = creator.contact?.email ? 6 : 0;
  return relevance + tagScore + followerScore + profileScore + contactScore;
}

function attachDiscoveryMeta(creators, meta) {
  Object.defineProperty(creators, "discoveryMeta", {
    value: meta,
    enumerable: false
  });
  return creators;
}

function readPositiveInt(value, fallback) {
  const number = Number(value || fallback);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("TikTok 搜索已取消");
}

function createDiscoveryEmptyError(message) {
  const error = new Error(message);
  error.name = "DiscoveryEmptyError";
  error.statusCode = 200;
  error.code = "DISCOVERY_EMPTY";
  return error;
}

function buildFallbackSearchFailureMessage(diagnostics = {}, elapsedMs = 0, errors = []) {
  const sources = Array.isArray(diagnostics.sources) ? diagnostics.sources : [];
  const sourcesTried = sources.length || diagnostics.configuredSources?.length || 1;
  const queriesTried = sources.reduce((total, source) => total + Number(source.queriesTried || 0), 0)
    || diagnostics.queryCount
    || 0;
  const rawResults = sumDiagnosticField(diagnostics, "rawResults");
  const profileCandidates = sumDiagnosticField(diagnostics, "profileCandidates");
  const parsedCandidates = sumDiagnosticField(diagnostics, "parsedCandidates");
  const candidateFiltered = sumDiagnosticField(diagnostics, "candidateFiltered");
  const negativeFiltered = sumDiagnosticField(diagnostics, "negativeFiltered");
  const timeoutCount = errors.filter(isTimeoutLikeMessage).length;
  const timeoutText = timeoutCount
    ? `其中 ${timeoutCount} 次请求超时或被中止。`
    : "";
  const diagnosisText = buildFallbackSearchDiagnosisText({
    rawResults,
    profileCandidates,
    parsedCandidates,
    candidateFiltered,
    negativeFiltered,
    configuredSources: diagnostics.configuredSources || []
  });

  return [
    `TikTok 公开网页搜索未召回候选：已尝试 ${sourcesTried} 个搜索源、${queriesTried} 次查询，用时 ${formatElapsedDuration(elapsedMs)}。`,
    rawResults ? `搜索源原始返回 ${rawResults} 条结果，识别到 ${profileCandidates} 条 TikTok @主页链接，通过候选构建 ${parsedCandidates} 条。` : "",
    candidateFiltered ? `有 ${candidateFiltered} 条 @主页被噪声或严格主题规则过滤。` : "",
    negativeFiltered ? `有 ${negativeFiltered} 条候选被负向关键词过滤。` : "",
    timeoutText,
    diagnosisText
  ].filter(Boolean).join("");
}

function buildFallbackSearchDiagnosisText({
  rawResults,
  profileCandidates,
  parsedCandidates,
  candidateFiltered,
  negativeFiltered,
  configuredSources
}) {
  if (!rawResults) {
    return configuredSources?.length
      ? "判断：搜索源基本没有返回可用搜索结果，优先检查关键词是否过窄、国家筛选是否过严，或稍后重试。"
      : "判断：当前只有公开网页兜底源，稳定性较弱，建议配置 Serper/Tavily/Brave/Jina 任一搜索源。";
  }
  if (!profileCandidates) {
    return "判断：搜索源有返回，但结果不是 TikTok @主页链接；建议减少限定词，或增加 creator/influencer/hashtag 类扩展词。";
  }
  if (!parsedCandidates && candidateFiltered) {
    return "判断：搜索结果里有 TikTok @主页，但被噪声或严格主题规则过滤；建议检查关键词是否触发了严格主题匹配。";
  }
  if (!parsedCandidates && negativeFiltered) {
    return "判断：搜索结果里有候选，但全部命中了排除词；建议检查负向关键词是否过宽。";
  }
  return "判断：搜索源返回不稳定，建议稍后重试，或降低每轮 query 数后优先使用稳定 API 源。";
}

function sumDiagnosticField(diagnostics = {}, field) {
  const sources = Array.isArray(diagnostics.sources) ? diagnostics.sources : [];
  return sources.reduce((total, source) => total + Number(source[field] || 0), 0);
}

function isTimeoutLikeMessage(message) {
  return /aborted|abort|timeout|timed out|超时|中止|取消/i.test(String(message || ""));
}

function shouldLogQueries() {
  return process.env.DISCOVERY_LOG_QUERIES === "true";
}

function formatElapsedDuration(ms) {
  const totalSeconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function chunkArray(items, size) {
  const chunkSize = Math.max(1, Number(size) || 1);
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

export const __testing = {
  buildAiSearchQuery,
  buildFallbackSearchFailureMessage,
  buildHashtagTerms,
  buildSearchQueries,
  candidatePriority,
  attachDiscoveryMeta,
  chunkArray,
  parsePublicTikTokProfile,
  parseSearchPage,
  readPositiveInt
};

function cleanProfileTitle(title, fallback) {
  const fallbackName = String(fallback || "").replace(/^@/, "");
  const text = cleanHtmlText(title)
    .replace(/\|\s*tiktok.*$/i, "")
    .replace(/-\s*tiktok.*$/i, "")
    .replace(/\s+on\s+tiktok$/i, "")
    .replace(/^tiktok\s*[-·:]\s*/i, "")
    .replace(/^@\w[\w.]*\s*[-·:]\s*/i, "")
    .replace(/\(@[^)]*\)/g, "")
    .replace(/^\d+\.\s*/, "")
    .trim();
  if (!isUsableDisplayName(text, fallbackName)) return fallbackName || "";
  return text;
}

function buildSearchResultBio(snippet, fallbackHandle) {
  const text = cleanHtmlText(snippet)
    .replace(/\s+/g, " ")
    .trim();
  if (!text || isTikTokBoilerplateText(text)) return "";
  if (isTagLikeTitle(text, fallbackHandle)) return "";
  return text.length > 220 ? `${text.slice(0, 217).trim()}...` : text;
}

function selectBestDisplayName(primary, fallback, handle) {
  const rawHandle = String(handle || "").replace(/^@/, "");
  const primaryName = cleanProfileTitle(primary, rawHandle);
  if (isUsableDisplayName(primaryName, rawHandle)) return primaryName;

  const fallbackName = cleanProfileTitle(fallback, rawHandle);
  if (isUsableDisplayName(fallbackName, rawHandle)) return fallbackName;
  return rawHandle || fallbackName || primaryName || "";
}

function isUsableDisplayName(name, fallbackHandle = "") {
  const text = cleanHtmlText(name);
  if (!text) return false;
  if (text.length > 80) return false;
  if (isTikTokBoilerplateText(text)) return false;
  if (isTagLikeTitle(text, fallbackHandle)) return false;
  return true;
}

function isTagLikeTitle(value, fallbackHandle = "") {
  const text = cleanHtmlText(value).toLowerCase();
  const handle = String(fallbackHandle || "").replace(/^@/, "").toLowerCase();
  if (!text) return true;
  if (handle && (text === handle || text === `@${handle}`)) return false;
  if (/^#/.test(text)) return true;
  if ((text.match(/#/g) || []).length >= 2) return true;
  if (/^(?:creator|influencer|female|woman|women|girl|girls|beauty|fashion|颜值|交友|黑丝)(?:[\s,，/|、#-]+(?:creator|influencer|female|woman|women|girl|girls|beauty|fashion|颜值|交友|黑丝))*$/i.test(text)) {
    return true;
  }
  return false;
}

function cleanMarkdownText(text) {
  return cleanHtmlText(String(text || "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1"));
}

function cleanHtmlText(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeYahooRedirect(url) {
  const cleanUrl = decodeHtmlEntities(String(url || ""));
  const match = cleanUrl.match(/\/RU=([^/]+)\/RK=/);
  if (!match) return cleanUrl;

  let decoded = match[1];
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }

  return decoded;
}

function getMetaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return "";
}

function getTagContent(html, tag) {
  const match = String(html || "").match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? cleanHtmlText(match[1]) : "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values) {
  return [...new Set(values.flat().filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
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

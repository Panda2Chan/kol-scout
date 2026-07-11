const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const YOUTUBE_PROFILE_PATHS = new Set(["channel", "c", "user"]);
const DEFAULT_QUERY_LIMIT = 10;
const DEFAULT_ENRICH_LIMIT = 20;
const DEFAULT_SEARCH_TIMEOUT_MS = 12_000;
const DEFAULT_PROFILE_TIMEOUT_MS = 12_000;

export const youtubeProvider = {
  platform: "youtube",
  get sourceName() {
    if (process.env.KOL_DATA_API_URL) return "third-party-http";
    return process.env.JINA_API_KEY ? "youtube-jina-search" : "youtube-direct-profile";
  },

  buildSearchUrl(plan) {
    const params = new URLSearchParams({
      search_query: plan.query || "creator channel"
    });
    params.set("sp", "EgIQAg==");
    return `https://www.youtube.com/results?${params.toString()}`;
  },

  buildProfileUrl(value) {
    return normalizeYoutubeProfile(value)?.profileUrl || "";
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
  const response = await fetch(process.env.KOL_DATA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.KOL_DATA_API_KEY ? { Authorization: `Bearer ${process.env.KOL_DATA_API_KEY}` } : {})
    },
    body: JSON.stringify({
      platform: "youtube",
      query: plan.query,
      keywords: plan.positiveTerms,
      excludeKeywords: plan.negativeTerms,
      filters: options.filters || {},
      limit: options.limit || 50
    }),
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error(`三方 YouTube 数据源请求失败：${response.status}`);
  }

  const payload = await response.json();
  const creators = Array.isArray(payload.creators) ? payload.creators : payload.results || payload.data || [];
  return creators.map((creator) => normalizeProviderCreator(creator, "third-party-http"));
}

async function discoverCreatorsFromFallbackSearch(plan, options = {}) {
  const startedAt = Date.now();
  const logger = options.logger || null;
  const limit = options.limit || 50;
  const found = new Map();
  const errors = [];

  for (const creator of buildDirectProfileCandidates(plan)) {
    mergeDiscoveredCreator(found, creator);
  }

  const hasJinaSearch = Boolean(process.env.JINA_API_KEY);
  const queries = hasJinaSearch
    ? buildSearchQueries(plan, options.filters || {})
      .slice(0, readPositiveInt(process.env.YOUTUBE_SEARCH_QUERY_LIMIT, DEFAULT_QUERY_LIMIT))
    : [];
  const diagnostics = {
    searchProvider: hasJinaSearch ? "jina-search" : "none",
    queryCount: queries.length,
    queries,
    directProfiles: found.size,
    rawFetched: found.size,
    enriched: 0,
    errors
  };

  logger?.info("youtube_fallback.start", {
    limit,
    searchProvider: diagnostics.searchProvider,
    queryCount: queries.length,
    directProfiles: found.size
  });

  if (!hasJinaSearch) {
    errors.push("未配置 JINA_API_KEY，已跳过 YouTube 公开搜索");
    logger?.warn("youtube_fallback.search_skipped", {
      reason: "missing JINA_API_KEY"
    });
  }

  for (const query of queries) {
    try {
      const text = await fetchJinaSearchPage(query, options.signal);
      const creators = parseYoutubeCreators(text, query, plan);
      for (const creator of creators) mergeDiscoveredCreator(found, creator);
    } catch (error) {
      errors.push(error.message);
      logger?.warn("youtube_fallback.query_error", {
        query,
        error: error.message
      });
    }

    if (found.size >= limit) break;
  }

  const creators = [...found.values()].slice(0, limit);
  diagnostics.rawFetched = found.size;
  diagnostics.enriched = Math.min(
    creators.length,
    readPositiveInt(process.env.YOUTUBE_ENRICH_LIMIT, DEFAULT_ENRICH_LIMIT)
  );
  const enriched = await enrichSearchCandidates(creators, diagnostics.enriched, options.signal, logger, options.onCandidate);
  enriched.discoveryMeta = {
    ...diagnostics,
    elapsedMs: Date.now() - startedAt
  };
  return enriched;
}

function buildDirectProfileCandidates(plan) {
  return (plan.directProfiles || [])
    .map(normalizeYoutubeProfile)
    .filter(Boolean)
    .map((profile) => buildSearchCandidate(profile, "direct profile", plan, profile.profileUrl, {
      confidence: 90,
      needsEnrichment: true
    }));
}

function buildSearchQueries(plan, filters = {}) {
  const positiveTerms = uniqueStrings([
    ...(plan.positiveTerms || []),
    ...(plan.aiSearch?.positiveTerms || []),
    ...(plan.aiSearch?.mustHave || [])
  ]).slice(0, 10);
  const negativeTerms = uniqueStrings(plan.negativeTerms || []).map((term) => `-${term}`);
  const coreTerms = positiveTerms.length ? positiveTerms : ["creator", "channel"];
  const country = countrySearchTerm(filters.country);
  const aiQueries = (plan.aiSearch?.queries || []).flatMap((query) => normalizeAiQuery(query, country, negativeTerms));
  const base = `${coreTerms.join(" ")} ${country} ${negativeTerms.join(" ")}`.replace(/\s+/g, " ").trim();

  return uniqueStrings([
    ...aiQueries.slice(0, 4),
    `site:youtube.com/@ ${base}`,
    `site:youtube.com/channel ${base}`,
    `site:youtube.com/c ${base}`,
    `site:youtube.com/user ${base}`,
    `site:www.youtube.com/@ ${base}`,
    ...aiQueries.slice(4)
  ]).filter((query) => query.length > "site:youtube.com".length);
}

function normalizeAiQuery(query, country, negativeTerms) {
  const raw = String(query || "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const clean = raw
    .replace(/\bsite:[^\s]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const suffix = [clean, country, ...negativeTerms].filter(Boolean).join(" ");
  return [
    `site:youtube.com/@ ${suffix}`,
    `site:youtube.com/channel ${suffix}`
  ];
}

async function fetchJinaSearchPage(query, signal) {
  const url = new URL("https://s.jina.ai/");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/plain",
      Authorization: `Bearer ${process.env.JINA_API_KEY}`
    },
    signal: createTimeoutSignal(DEFAULT_SEARCH_TIMEOUT_MS, signal)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(buildJinaSearchErrorMessage(response.status, text));
  }
  return text;
}

function parseYoutubeCreators(text, query, plan = {}) {
  const sourceText = String(text || "");
  const creators = [];
  const seen = new Set();
  const linkPattern = /\[([^\]]{2,120})\]\((https?:\/\/(?:www\.|m\.)?youtube\.com\/[^)\s]+)\)|https?:\/\/(?:www\.|m\.)?youtube\.com\/[^\s"'<>)]*/gi;

  for (const match of sourceText.matchAll(linkPattern)) {
    const rawUrl = match[2] || match[0];
    const profile = normalizeYoutubeProfile(rawUrl);
    if (!profile || seen.has(profile.profileUrl)) continue;
    seen.add(profile.profileUrl);

    const evidence = excerptLine(sourceText, match.index || 0);
    if (isLowEvidenceSearchResult(profile, evidence)) continue;
    creators.push(buildSearchCandidate(profile, match[1] || "", plan, profile.profileUrl, {
      query,
      evidenceText: evidence,
      confidence: evidence ? 74 : 62,
      needsEnrichment: true
    }));
  }

  return creators;
}

async function enrichSearchCandidates(creators, enrichLimit, signal, logger, onCandidate) {
  const enriched = [];
  for (const creator of creators) {
    const next = enriched.length < enrichLimit
      ? await enrichFromPublicProfile(creator, signal).catch((error) => {
          logger?.warn("youtube_enrich.error", {
            profileUrl: creator.profileUrl,
            error: error.message
          });
          return creator;
        })
      : creator;
    enriched.push(next);
    if (onCandidate && hasMinimumYoutubeEvidence(next)) {
      await Promise.resolve(onCandidate(next, {
        stage: "youtube-enriched",
        fetched: creators.length,
        enriched: enriched.length
      })).catch(() => null);
    }
  }
  return enriched;
}

async function enrichFromPublicProfile(creator, signal) {
  const profile = normalizeYoutubeProfile(creator.profileUrl || creator.handle);
  if (!profile) return creator;

  const response = await fetch(profile.profileUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,text/plain"
    },
    signal: createTimeoutSignal(DEFAULT_PROFILE_TIMEOUT_MS, signal)
  });

  if (!response.ok) return creator;
  const text = await response.text();
  const name = cleanText(extractMeta(text, "og:title") || extractTitle(text) || creator.name || profile.handle);
  const bio = cleanText(extractMeta(text, "description") || extractMeta(text, "og:description") || creator.bio || "");
  const avatarUrl = extractMeta(text, "og:image") || creator.avatarUrl || "";
  const followers = parseSubscriberCount(text) ?? creator.metrics?.followers ?? null;
  const email = extractEmail(text) || creator.contact?.email || "";
  const tags = uniqueStrings([...(creator.tags || []), ...extractTopicTags(`${bio} ${creator.discovery?.evidenceText || ""}`)]).slice(0, 10);

  return {
    ...creator,
    name: name || creator.name,
    handle: creator.handle || profile.handle,
    profileUrl: profile.profileUrl,
    avatarUrl,
    bio,
    contact: {
      ...creator.contact,
      email,
      source: email ? "youtube-public-profile" : creator.contact?.source || "",
      available: Boolean(email)
    },
    metrics: {
      ...creator.metrics,
      followers
    },
    tags,
    discovery: {
      ...creator.discovery,
      evidenceText: cleanText([creator.discovery?.evidenceText, bio, followers ? `${followers} subscribers` : ""].filter(Boolean).join("\n")),
      needsEnrichment: false
    },
    enrichment: {
      ...creator.enrichment,
      status: hasMinimumYoutubeEvidence({ ...creator, bio, avatarUrl, metrics: { ...creator.metrics, followers }, tags }) ? "enriched" : "partial",
      provider: "youtube-public-profile",
      lastEnrichedAt: Date.now(),
      error: ""
    }
  };
}

function buildSearchCandidate(profile, title, plan, pageUrl, options = {}) {
  const name = cleanCreatorName(title, profile);
  const evidenceText = cleanText(options.evidenceText || "");
  const tags = extractTopicTags(`${plan.query || ""} ${(plan.positiveTerms || []).join(" ")} ${evidenceText}`);
  const followers = parseSubscriberCount(evidenceText);

  return {
    id: `youtube:${profile.key}`.toLowerCase(),
    platform: "youtube",
    name,
    handle: profile.handle,
    profileUrl: profile.profileUrl,
    avatarUrl: "",
    bio: "",
    contact: {
      email: extractEmail(evidenceText),
      source: extractEmail(evidenceText) ? "search-evidence" : "",
      available: Boolean(extractEmail(evidenceText))
    },
    metrics: {
      followers,
      following: null,
      likes: null,
      posts: null,
      avgEngagement: null
    },
    tags,
    relevanceScore: options.confidence ?? 70,
    sourceProvider: "youtube-web-search",
    discovery: {
      kind: "web-search",
      confidence: options.confidence ?? 70,
      summary: "来自 YouTube 公开网页搜索的频道候选，已做主页形态校验。",
      evidenceText,
      needsEnrichment: options.needsEnrichment ?? true,
      relevanceScore: options.confidence ?? 70,
      sourceProvider: "youtube-web-search"
    },
    enrichment: {
      status: options.needsEnrichment ? "partial" : "enriched",
      provider: "youtube-web-search",
      lastEnrichedAt: Date.now(),
      error: ""
    },
    source: {
      pageUrl,
      pageTitle: "YouTube 公开网页搜索",
      capturedAt: Date.now()
    }
  };
}

function normalizeProviderCreator(creator, sourceProvider) {
  const profile = normalizeYoutubeProfile(creator.profileUrl || creator.url || creator.handle || creator.channelUrl);
  const profileUrl = profile?.profileUrl || creator.profileUrl || "";
  return {
    ...creator,
    id: creator.id || `youtube:${profile?.key || creator.handle || profileUrl || creator.name}`.toLowerCase(),
    platform: "youtube",
    handle: creator.handle || profile?.handle || "",
    profileUrl,
    metrics: {
      ...creator.metrics,
      followers: creator.metrics?.followers ?? creator.metrics?.subscribers ?? parseSubscriberCount(creator.subscribers) ?? null
    },
    sourceProvider,
    discovery: {
      ...creator.discovery,
      sourceProvider: creator.discovery?.sourceProvider || creator.sourceProvider || sourceProvider
    }
  };
}

function normalizeYoutubeProfile(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^@[A-Za-z0-9._-]{2,64}$/.test(raw)) {
    const handle = raw;
    return {
      kind: "handle",
      key: handle.toLowerCase(),
      handle,
      profileUrl: `https://www.youtube.com/${handle}`
    };
  }

  const pathProfile = raw.match(/^(channel|c|user)\/([A-Za-z0-9._-]{2,128})$/i);
  if (pathProfile) {
    const kind = pathProfile[1].toLowerCase();
    const id = pathProfile[2];
    return {
      kind,
      key: `${kind}/${id}`.toLowerCase(),
      handle: `${kind}/${id}`,
      profileUrl: `https://www.youtube.com/${kind}/${id}`
    };
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const segments = url.pathname.split("/").map((part) => decodeURIComponent(part)).filter(Boolean);
  if (!segments.length) return null;

  const first = segments[0];
  if (first.startsWith("@") && /^@[A-Za-z0-9._-]{2,64}$/.test(first)) {
    return {
      kind: "handle",
      key: first.toLowerCase(),
      handle: first,
      profileUrl: `https://www.youtube.com/${first}`
    };
  }

  if (YOUTUBE_PROFILE_PATHS.has(first.toLowerCase()) && segments[1]) {
    const kind = first.toLowerCase();
    const id = segments[1].replace(/[?#].*$/, "");
    if (!/^[A-Za-z0-9._-]{2,128}$/.test(id)) return null;
    return {
      kind,
      key: `${kind}/${id}`.toLowerCase(),
      handle: `${kind}/${id}`,
      profileUrl: `https://www.youtube.com/${kind}/${id}`
    };
  }

  return null;
}

function isLowEvidenceSearchResult(profile, evidence) {
  const lower = String(evidence || "").toLowerCase();
  if (/(playlist|watch\?|shorts\/|youtube music| - youtube$)/i.test(profile.profileUrl)) return true;
  if (/(official store|official shop|news|brand channel|topic channel|auto-generated by youtube)/i.test(lower)) return true;
  return false;
}

function hasMinimumYoutubeEvidence(creator) {
  const signals = [
    Boolean(creator.profileUrl),
    Boolean(creator.name && creator.name !== "Unknown creator"),
    Boolean(creator.bio && creator.bio.length >= 20),
    creator.metrics?.followers != null,
    Boolean(creator.avatarUrl),
    (creator.tags || []).length >= 1,
    Boolean(creator.discovery?.evidenceText)
  ].filter(Boolean).length;
  return signals >= 3;
}

function cleanCreatorName(title, profile) {
  const clean = cleanText(String(title || "")
    .replace(/\s*-\s*YouTube\s*$/i, "")
    .replace(/\s*\|\s*YouTube\s*$/i, ""));
  if (clean && !/^https?:\/\//i.test(clean)) return clean;
  return profile.handle || "Unknown creator";
}

function buildJinaSearchErrorMessage(status, body) {
  const detail = cleanText(body).slice(0, 180);
  const suffix = detail ? `：${detail}` : "";
  if (status === 401) return `Jina API Key 无效或缺失${suffix}`;
  if (status === 403) return `Jina API 额度不足或无权限${suffix}`;
  if (status === 429) return `Jina API 请求过于频繁或额度受限${suffix}`;
  return `Jina Search 请求失败：${status}${suffix}`;
}

function parseSubscriberCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = String(value || "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*([kKmMbB万千]?)\s*(?:subscribers?|订阅者|位订阅|粉丝|followers?)/i)
    || text.match(/(?:subscribers?|订阅者|粉丝|followers?)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*([kKmMbB万千]?)/i);
  if (!match) return null;
  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000, 千: 1_000, 万: 10_000 };
  return Math.round(Number(match[1]) * (multipliers[String(match[2] || "").toLowerCase()] || multipliers[match[2]] || 1));
}

function extractTopicTags(text) {
  const lower = String(text || "").toLowerCase();
  const tags = [];
  const dictionary = ["beauty", "makeup", "skincare", "gaming", "fitness", "travel", "food", "tech", "ai", "saas", "review", "tutorial", "cosplay"];
  for (const tag of dictionary) {
    if (lower.includes(tag)) tags.push(tag);
  }
  if (/美妆/.test(text)) tags.push("美妆");
  if (/护肤/.test(text)) tags.push("护肤");
  if (/教程|教学/.test(text)) tags.push("教程");
  if (/测评|评测/.test(text)) tags.push("测评");
  return uniqueStrings(tags);
}

function extractMeta(html, property) {
  const escaped = escapeRegExp(property);
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function extractTitle(html) {
  return decodeHtml(String(html || "").match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "");
}

function extractEmail(text) {
  return String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
}

function excerptLine(text, index) {
  const source = String(text || "");
  const safeIndex = Math.max(0, Number(index) || 0);
  const start = Math.max(0, source.lastIndexOf("\n", safeIndex) + 1);
  const endIndex = source.indexOf("\n", safeIndex);
  const end = endIndex === -1 ? source.length : endIndex;
  return cleanText(stripHtml(source.slice(start, end)));
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanText(value) {
  return decodeHtml(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function countrySearchTerm(countryCode) {
  const map = {
    US: "United States",
    GB: "United Kingdom",
    CA: "Canada",
    AU: "Australia",
    JP: "Japan Japanese",
    KR: "Korea Korean",
    SG: "Singapore",
    DE: "Germany",
    FR: "France",
    IT: "Italy",
    ES: "Spain",
    BR: "Brazil",
    MX: "Mexico",
    ID: "Indonesia",
    TH: "Thailand",
    VN: "Vietnam",
    PH: "Philippines",
    MY: "Malaysia",
    IN: "India"
  };
  return map[String(countryCode || "").toUpperCase()] || "";
}

function mergeDiscoveredCreator(found, creator) {
  const key = creator.id || creator.profileUrl || creator.handle;
  if (!key) return;
  const previous = found.get(key);
  found.set(key, previous ? {
    ...previous,
    ...creator,
    metrics: { ...previous.metrics, ...creator.metrics },
    tags: uniqueStrings([...(previous.tags || []), ...(creator.tags || [])]),
    discovery: { ...previous.discovery, ...creator.discovery }
  } : creator);
}

function uniqueStrings(values) {
  return [...new Set((values || [])
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
  )];
}

function readPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const __testing = {
  buildSearchQueries,
  normalizeYoutubeProfile,
  parseSubscriberCount,
  parseYoutubeCreators,
  enrichFromPublicProfile
};

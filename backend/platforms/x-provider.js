export const xProvider = {
  platform: "x",
  get sourceName() {
    return process.env.KOL_DATA_API_URL ? "third-party-http" : "yahoo-web-search";
  },

  buildSearchUrl(plan) {
    const params = new URLSearchParams({
      q: plan.query || "creator",
      src: "typed_query",
      f: plan.mode === "people" ? "user" : "live"
    });

    return `https://x.com/search?${params.toString()}`;
  },

  buildProfileUrl(handle) {
    const rawHandle = String(handle || "").replace(/^@/, "").trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(rawHandle)) return "";
    return `https://x.com/${rawHandle}`;
  },

  async discoverCreators(plan, options = {}) {
    if (process.env.KOL_DATA_API_URL) {
      return discoverCreatorsFromHttp(plan, options);
    }

    return discoverCreatorsFromYahooSearch(plan, options);
  },

  async enrich(creator) {
    const publicProfile = await enrichFromPublicProfile(creator);
    const inferredBio = publicProfile.bio || inferBioFromEvidence(publicProfile);
    const inferredFollowers = publicProfile.metrics?.followers ?? inferFollowersFromEvidence(publicProfile);

    return {
      ...publicProfile,
      bio: inferredBio,
      metrics: {
        ...publicProfile.metrics,
        followers: inferredFollowers
      },
      enrichment: {
        ...publicProfile.enrichment,
        status: inferredBio || inferredFollowers || publicProfile.avatarUrl ? "enriched" : "partial",
        provider: publicProfile.enrichment?.provider || "x-provider-evidence",
        lastEnrichedAt: Date.now(),
        error: ""
      }
    };
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
      platform: "x",
      query: plan.query,
      keywords: plan.positiveTerms,
      excludeKeywords: plan.negativeTerms,
      filters: options.filters || {},
      limit: options.limit || 50
    })
  });

  if (!response.ok) {
    throw new Error(`三方数据源请求失败：${response.status}`);
  }

  const payload = await response.json();
  const creators = Array.isArray(payload.creators) ? payload.creators : payload.results || payload.data || [];
  return creators.map((creator) => ({
    ...creator,
    sourceProvider: creator.sourceProvider || "third-party-http",
    discovery: {
      ...creator.discovery,
      sourceProvider: creator.discovery?.sourceProvider || creator.sourceProvider || "third-party-http"
    }
  }));
}

async function discoverCreatorsFromYahooSearch(plan, options = {}) {
  const limit = options.limit || 50;
  const found = new Map();
  const errors = [];

  for (const creator of buildDirectProfileCandidates(plan)) {
    mergeDiscoveredCreator(found, creator);
  }

  const maxQueries = plan.aiSearch?.enabled ? 10 : 6;

  for (const query of buildYahooQueries(plan).slice(0, maxQueries)) {
    try {
      const html = await fetchYahooSearch(query);
      let creators = parseYahooCreators(html, query, plan);
      if (!creators.length) {
        const markdown = await fetchYahooSearchMarkdown(query).catch((error) => {
          errors.push(`jina-empty-fallback:${error.message}`);
          return "";
        });
        if (markdown) creators = parseYahooCreators(markdown, query, plan);
      }

      for (const creator of creators) mergeDiscoveredCreator(found, creator);
    } catch (error) {
      errors.push(error.message);
    }

    if (found.size >= limit) break;
  }

  if (!found.size && errors.length) {
    throw new Error(`真实网页搜索失败：${errors[0]}`);
  }

  const creators = [...found.values()].slice(0, limit);
  return enrichSearchCandidates(creators, Math.min(creators.length, 20));
}

function buildDirectProfileCandidates(plan) {
  return (plan.directProfiles || [])
    .map((handle) => normalizeXProfile(`https://x.com/${String(handle).replace(/^@/, "")}`))
    .filter(Boolean)
    .map((profile) => buildSearchCandidate(profile, "direct profile", plan, profile.profileUrl));
}

function buildYahooQueries(plan) {
  const rawText = plan.normalizedBrief?.rawText || plan.query || "";
  const positiveTerms = plan.positiveTerms || [];
  const expandedTerms = expandSearchTerms(rawText, positiveTerms);
  const coreEnglishTerms = buildCoreEnglishTerms(rawText, positiveTerms);
  const chineseTerms = extractChineseSearchTerms(rawText);
  const negativeTerms = (plan.negativeTerms || []).map((term) => `-${term}`);
  const compactTerms = unique([...positiveTerms, ...expandedTerms]).slice(0, 10);
  const aiQueries = (plan.aiSearch?.queries || []).flatMap((query) => buildSiteQueries(query));
  const broadQueries = [
    coreEnglishTerms.length ? `site:x.com ${coreEnglishTerms.join(" ")} ${negativeTerms.join(" ")}` : "",
    coreEnglishTerms.length ? `site:x.com ${coreEnglishTerms.filter((term) => term !== "female").join(" ")} ${negativeTerms.join(" ")}` : "",
    chineseTerms.length ? `site:x.com ${chineseTerms.join(" ")} ${negativeTerms.join(" ")}` : "",
    `site:x.com ${compactTerms.join(" ")} ${negativeTerms.join(" ")}`,
    coreEnglishTerms.length ? `site:twitter.com ${coreEnglishTerms.join(" ")} ${negativeTerms.join(" ")}` : "",
    `site:twitter.com ${expandedTerms.slice(0, 8).join(" ")} ${negativeTerms.join(" ")}`
  ];

  return unique([
    ...aiQueries.slice(0, 4),
    ...broadQueries,
    ...aiQueries.slice(4)
  ])
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter((query) => query.length > "site:x.com".length);
}

function buildSiteQueries(query) {
  const raw = String(query || "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  if (/\bsite:x\.com\b/i.test(raw)) return [raw, raw.replace(/\bsite:x\.com\b/i, "site:twitter.com")];
  if (/\bsite:twitter\.com\b/i.test(raw)) return [raw, raw.replace(/\bsite:twitter\.com\b/i, "site:x.com")];

  const clean = raw
    .replace(/\bsite:(?:x|twitter)\.com\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  return [`site:x.com ${clean}`, `site:twitter.com ${clean}`];
}

function buildCoreEnglishTerms(rawText, terms = []) {
  const haystack = `${rawText} ${terms.join(" ")}`.toLowerCase();
  const core = [];

  if (/亚洲|asian/.test(haystack)) core.push("asian");
  if (/女|女性|woman|women|female/.test(haystack)) core.push("female");
  if (/美妆|beauty|makeup|护肤|skincare/.test(haystack)) core.push("beauty", "makeup");
  if (/coser|cosplay|cosplayer|二次元|角色扮演|\bcos\b/i.test(haystack)) {
    core.push("coser", "cosplay", "cosplayer");
  }
  if (/博主|达人|creator|influencer|kol/.test(haystack)) core.push("blogger");
  if (!core.length) core.push(...terms.filter((term) => /^[a-z0-9+#. ]+$/i.test(term)).slice(0, 5));
  if (!core.length) core.push("creator");

  return unique(core).slice(0, 6);
}

function expandSearchTerms(rawText, terms = []) {
  const haystack = `${rawText} ${terms.join(" ")}`.toLowerCase();
  const expanded = [...terms];

  if (/美妆|beauty|makeup|护肤|skincare/.test(haystack)) {
    expanded.push("beauty", "makeup", "skincare", "beauty blogger");
  }
  if (/亚洲|asian/.test(haystack)) expanded.push("asian");
  if (/女|女性|woman|women|female/.test(haystack)) expanded.push("female", "woman");
  if (/coser|cosplay|cosplayer|二次元|角色扮演|\bcos\b/i.test(haystack)) {
    expanded.push("coser", "cosplay", "cosplayer", "anime", "costume");
  }
  if (/博主|达人|creator|influencer|kol/.test(haystack)) {
    expanded.push("blogger", "creator", "influencer");
  }
  if (/教程|tutorial|how to/.test(haystack)) expanded.push("tutorial");
  if (/测评|评测|review/.test(haystack)) expanded.push("review");

  return unique(expanded).filter((term) => !/^-/.test(term));
}

function extractChineseSearchTerms(text) {
  const raw = String(text || "");
  const terms = [];
  if (/亚洲/.test(raw)) terms.push("亚洲");
  if (/女|女性/.test(raw)) terms.push("女", "女性");
  if (/美妆/.test(raw)) terms.push("美妆");
  if (/护肤/.test(raw)) terms.push("护肤");
  if (/二次元/.test(raw)) terms.push("二次元");
  if (/角色扮演/.test(raw)) terms.push("角色扮演");
  if (/博主/.test(raw)) terms.push("博主");
  return unique(terms);
}

async function fetchYahooSearch(query) {
  const errors = [];

  for (const host of YAHOO_SEARCH_HOSTS) {
    const url = new URL(`https://${host}/search`);
    url.searchParams.set("p", query);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "text/html"
        },
        signal: AbortSignal.timeout(8000)
      });

      const html = await response.text();
      if (response.ok && html) return html;
      errors.push(`${host}:${response.status}`);
    } catch (error) {
      errors.push(`${host}:${error.message}`);
    }
  }

  const markdown = await fetchYahooSearchMarkdown(query).catch((error) => {
    errors.push(`jina-yahoo:${error.message}`);
    return "";
  });
  if (markdown) return markdown;

  throw new Error(`Yahoo Search 请求失败：${errors.join(" / ")}`);
}

function parseYahooCreators(html, query, plan) {
  const results = extractYahooResults(html);
  return results
    .map((result) => {
      const profile = normalizeXProfile(result.url);
      if (!profile) return null;
      return buildSearchCandidate(profile, query, plan, result.url, result);
    })
    .filter(Boolean)
    .filter((creator) => matchesNegativeTerms(creator, plan.negativeTerms || []));
}

function extractYahooResults(html) {
  const results = [];
  const decodedHtml = decodeHtmlEntities(String(html || ""));

  results.push(...extractMarkdownSearchResults(decodedHtml));

  for (const match of decodedHtml.matchAll(/<li\b[^>]*class="[^"]*\balgo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = match[1];
    const redirect = block.match(/href="(https?:\/\/r\.search\.yahoo\.com\/[^"]+)"/i)?.[1];
    const targetUrl = redirect ? decodeYahooRedirect(redirect) : "";
    if (!targetUrl) continue;

    results.push({
      url: targetUrl,
      title: cleanHtmlText(block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || ""),
      snippet: cleanHtmlText(block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "")
    });
  }

  for (const match of decodedHtml.matchAll(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}(?:[/?#][^"'<>\s]*)?/gi)) {
    results.push({ url: match[0], title: "", snippet: "" });
  }

  const byUrl = new Map();
  for (const result of results) {
    const profile = normalizeXProfile(result.url);
    if (!profile) continue;
    if (!byUrl.has(profile.profileUrl)) {
      byUrl.set(profile.profileUrl, { ...result, url: result.url });
      continue;
    }

    const previous = byUrl.get(profile.profileUrl);
    byUrl.set(profile.profileUrl, {
      ...previous,
      title: previous.title || result.title,
      snippet: previous.snippet || result.snippet
    });
  }

  return [...byUrl.values()];
}

async function fetchYahooSearchMarkdown(query) {
  const yahooUrl = `http://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  const url = `https://r.jina.ai/${yahooUrl}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/plain"
    },
    signal: AbortSignal.timeout(10000)
  });

  const text = await response.text();
  if (!response.ok || !text.includes("Search Results")) {
    throw new Error(`Jina Yahoo 请求失败：${response.status}`);
  }

  return text;
}

function extractMarkdownSearchResults(markdown) {
  const results = [];

  for (const line of String(markdown || "").split("\n")) {
    if (!/^\s*\d+\.\s+/.test(line)) continue;
    const text = cleanMarkdownText(line);
    const handle = extractHandleFromSearchLine(text);
    if (!handle) continue;
    if (RESERVED_X_PATHS.has(handle.toLowerCase())) continue;

    results.push({
      url: `https://x.com/${handle}`,
      title: text.split(" - ")[0] || handle,
      snippet: text
    });
  }

  return results;
}

function extractHandleFromSearchLine(text) {
  const raw = String(text || "");
  const atHandle = raw.match(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_]{1,15})(?!\.)/)?.[2];
  if (atHandle && !isInvalidHandleCandidate(atHandle)) return atHandle;

  const xUrlHandle = raw.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|\s|$)/i)?.[1];
  if (xUrlHandle && !isInvalidHandleCandidate(xUrlHandle)) return xUrlHandle;

  const namedHandle = raw.match(/^([A-Za-z0-9_]{3,15})\s*\(/)?.[1];
  if (namedHandle && !isInvalidHandleCandidate(namedHandle)) return namedHandle;

  const hashtagHandle = raw.match(/#([A-Za-z0-9_]*(?:coser|cosplay|beauty|makeup|asian)[A-Za-z0-9_]*)/i)?.[1];
  return hashtagHandle && !isInvalidHandleCandidate(hashtagHandle) ? hashtagHandle : "";
}

function isInvalidHandleCandidate(handle) {
  const normalized = String(handle || "").toLowerCase();
  return RESERVED_X_PATHS.has(normalized) || EMAIL_DOMAIN_HANDLES.has(normalized);
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

function normalizeXProfile(targetUrl) {
  try {
    const url = new URL(decodeHtmlEntities(String(targetUrl || "")));
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!["x.com", "twitter.com"].includes(host)) return null;

    const [rawHandle] = url.pathname.split("/").filter(Boolean);
    if (!/^[A-Za-z0-9_]{1,15}$/.test(rawHandle || "")) return null;
    if (RESERVED_X_PATHS.has(rawHandle.toLowerCase())) return null;

    return {
      rawHandle,
      handle: `@${rawHandle}`,
      profileUrl: `https://x.com/${rawHandle}`,
      sourceUrl: url.toString()
    };
  } catch {
    return null;
  }
}

function buildSearchCandidate(profile, query, plan, sourceUrl, result = {}) {
  if (isNoisySearchResult(result)) return null;

  const terms = expandSearchTerms(plan.normalizedBrief?.rawText || plan.query || "", plan.positiveTerms || []);
  const observedText = [result.title, result.snippet, profile.rawHandle].filter(Boolean).join(" ");
  const matchedTerms = selectObservedTerms(observedText, terms);
  const evidenceText = [
    result.title ? `title: ${result.title}` : "",
    result.snippet ? `snippet: ${result.snippet}` : "",
    `matchedUrl: ${sourceUrl}`,
    matchedTerms.length ? `matchedTerms: ${matchedTerms.join(" ")}` : ""
  ].filter(Boolean).join("; ");

  return {
    platform: "x",
    name: result.title ? cleanProfileTitle(result.title, profile.rawHandle) : profile.rawHandle,
    handle: profile.handle,
    profileUrl: profile.profileUrl,
    avatarUrl: "",
    bio: "",
    contact: buildContactFromText([result.title, result.snippet].filter(Boolean).join(" ")),
    metrics: {
      followers: inferFollowersFromEvidence({ discovery: { evidenceText: [result.title, result.snippet].filter(Boolean).join(" ") } }),
      following: null,
      posts: null,
      avgEngagement: null
    },
    tags: matchedTerms.slice(0, 12),
    sourceProvider: "yahoo-web-search",
    discovery: {
      kind: "web-search",
      confidence: query === "direct profile" ? 82 : 72,
      summary: "Yahoo Search 真实搜索命中该 X 账号，已尝试读取公开主页资料。",
      evidenceText,
      needsEnrichment: true,
      sourceProvider: "yahoo-web-search"
    },
    enrichment: {
      status: "partial",
      provider: "yahoo-web-search"
    },
    source: {
      pageUrl: sourceUrl,
      pageTitle: "Yahoo Search",
      capturedAt: Date.now()
    }
  };
}

function isNoisySearchResult(result = {}) {
  const text = [result.title, result.snippet].join(" ");
  if (/!\[image/i.test(text)) return true;
  if (/^x\s+https?:/i.test(text)) return true;
  if (!cleanHtmlText(text) && !result.url) return true;
  return false;
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

async function enrichSearchCandidates(creators, maxEnrichCount) {
  const enriched = [];
  for (const creator of creators) {
    if (enriched.length < maxEnrichCount) {
      enriched.push(await enrichFromPublicProfile(creator));
      continue;
    }
    enriched.push(creator);
  }
  return enriched;
}

async function enrichFromPublicProfile(creator) {
  if (!creator.profileUrl) return creator;

  try {
    const response = await fetch(creator.profileUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) return creator;

    const html = await response.text();
    const profile = parsePublicXProfile(html, creator.handle);
    if (!profile.bio && !profile.avatarUrl && !profile.name && !profile.followers && !profile.contact.email) return creator;
    const evidenceText = unique([
      creator.discovery?.evidenceText,
      profile.bio ? `profileBio: ${profile.bio}` : "",
      profile.followers ? `${profile.followers} followers` : "",
      profile.contact.email ? `email: ${profile.contact.email}` : ""
    ]).join("\n");

    return {
      ...creator,
      name: profile.name || creator.name,
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
        status: profile.bio || profile.followers || profile.contact.email ? "ready" : creator.enrichment?.status || "partial",
        provider: "x-public-profile"
      }
    };
  } catch {
    return creator;
  }
}

function parsePublicXProfile(html, handle) {
  const title = getMetaContent(html, "og:title") || getTagContent(html, "title");
  const description = getMetaContent(html, "description") || getMetaContent(html, "og:description");
  const image = getMetaContent(html, "og:image");
  const cleanDescription = cleanHtmlText(description);
  const titleText = cleanHtmlText(title);
  const text = cleanHtmlText(`${titleText} ${cleanDescription} ${html}`);

  return {
    name: cleanProfileTitle(title, String(handle || "").replace(/^@/, "")),
    bio: cleanDescription,
    avatarUrl: image || "",
    followers: inferFollowersFromText(text),
    contact: buildContactFromText(text)
  };
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

function matchesNegativeTerms(creator, negativeTerms) {
  if (!negativeTerms.length) return true;
  const haystack = [
    creator.name,
    creator.bio,
    creator.discovery?.evidenceText,
    ...(creator.tags || [])
  ].join(" ").toLowerCase();
  return !negativeTerms.some((term) => haystack.includes(String(term).toLowerCase()));
}

function cleanProfileTitle(title, fallback = "") {
  const cleanTitle = cleanHtmlText(title)
    .replace(/^\w{3}\s+\d{1,2},\s+\d{4}\s*·\s*/i, "")
    .replace(/\s*\/\s*(?:X|Twitter).*$/i, "")
    .replace(/\s+on\s+X$/i, "")
    .replace(/\s*-\s*Yahoo Search Results$/i, "")
    .trim();
  return cleanTitle || fallback;
}

const RESERVED_X_PATHS = new Set([
  "about",
  "compose",
  "coser",
  "cosplay",
  "explore",
  "event",
  "events",
  "hashtag",
  "home",
  "i",
  "intent",
  "jobs",
  "login",
  "messages",
  "notifications",
  "privacy",
  "search",
  "settings",
  "share",
  "tos"
]);

const EMAIL_DOMAIN_HANDLES = new Set([
  "gmail",
  "hotmail",
  "icloud",
  "outlook",
  "protonmail",
  "qq",
  "yahoo"
]);

const YAHOO_SEARCH_HOSTS = ["search.yahoo.com", "sg.search.yahoo.com", "uk.search.yahoo.com"];

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&rsquo;", "'")
    .replaceAll("&lsquo;", "'")
    .replaceAll("&rdquo;", "\"")
    .replaceAll("&ldquo;", "\"")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function cleanHtmlText(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMarkdownText(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\s*\|\s*X\s*\(formerly Twitter\)\s*$/i, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function inferBioFromEvidence(creator) {
  const evidence = creator.discovery?.evidenceText || "";
  const lines = evidence
    .split(/[。.!?\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 24 && !line.includes(creator.handle));

  return lines[0]?.slice(0, 220) || "";
}

function inferFollowersFromEvidence(creator) {
  const text = creator.discovery?.evidenceText || "";
  return inferFollowersFromText(text);
}

function inferFollowersFromText(text) {
  const match = String(text || "").match(/([\d,.]+)\s*([KMB万亿千]?)\s*(followers|粉丝|关注者)/i);
  if (!match) return null;

  const base = Number(match[1].replaceAll(",", ""));
  const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000, 千: 1_000, 万: 10_000, 亿: 100_000_000 };
  return Number.isNaN(base) ? null : Math.round(base * (multipliers[match[2]] || 1));
}

function extractEmail(text) {
  const match = String(text || "")
    .replace(/\s*(?:\[at]|\(at\)| at )\s*/gi, "@")
    .replace(/\s*(?:\[dot]|\(dot\)| dot )\s*/gi, ".")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] || "";
}

const DEFAULT_BRIEF = {
  rawText: "",
  platforms: [],
  creatorKeywords: [],
  excludeKeywords: [],
  followerRange: { min: null, max: null }
};

const SEARCH_STOPWORDS = new Set([
  "a",
  "about",
  "and",
  "creator",
  "creators",
  "find",
  "for",
  "from",
  "influencer",
  "influencers",
  "kol",
  "kols",
  "need",
  "of",
  "on",
  "or",
  "platform",
  "related",
  "search",
  "the",
  "to",
  "twitter",
  "want",
  "with",
  "x",
  "一个",
  "一些",
  "以及",
  "不要",
  "帮我",
  "创作者",
  "分析",
  "博主",
  "看看",
  "和",
  "寻找",
  "平台",
  "找",
  "排除",
  "类似",
  "类似的",
  "相关",
  "粉丝",
  "账号",
  "账户",
  "主页",
  "网红",
  "达人",
  "需要",
  "做",
  "上做",
  "中文",
  "英文"
]);

export function matchCreators(briefInput, creators) {
  const brief = normalizeBrief(briefInput);
  return creators
    .map((creator) => ({
      creatorId: creator.id,
      match: scoreCreator(brief, creator)
    }))
    .sort((a, b) => b.match.score - a.match.score);
}

export function buildCreatorSearchPlan(briefInput = {}, options = {}) {
  const brief = normalizeBrief(briefInput);
  const platform = normalizeSearchPlatform(options.platform || brief.platforms[0] || "x");
  const negativeTerms = buildNegativeSearchTerms(brief);
  const positiveTerms = buildPositiveSearchTerms(brief, negativeTerms);
  const query = buildSearchQuery(positiveTerms, negativeTerms);

  return {
    platform,
    mode: platform === "x" ? "people" : "default",
    provider: "search-plan-rules-v1",
    briefId: brief.id || "brief:adhoc",
    query,
    positiveTerms,
    negativeTerms,
    directProfiles: extractDirectProfiles(brief.rawText, platform),
    normalizedBrief: brief,
    constraints: {
      followerRange: brief.followerRange
    },
    notes: buildSearchNotes(brief)
  };
}

export function normalizeBrief(input = {}) {
  const rawText = String(input.rawText || input.text || "");
  const parsed = parseRawBrief(rawText);

  return {
    ...DEFAULT_BRIEF,
    ...input,
    rawText,
    platforms: unique([...(input.platforms || []), ...parsed.platforms]),
    creatorKeywords: unique([...(input.creatorKeywords || []), ...parsed.creatorKeywords]),
    excludeKeywords: unique([...(input.excludeKeywords || []), ...parsed.excludeKeywords]),
    followerRange: {
      min: input.followerRange?.min ?? parsed.followerRange.min,
      max: input.followerRange?.max ?? parsed.followerRange.max
    }
  };
}

function scoreCreator(brief, creator) {
  const haystack = [
    creator.name,
    creator.handle,
    creator.bio,
    creator.discovery?.evidenceText,
    ...(creator.tags || []),
    creator.notes
  ].join(" ").toLowerCase();

  const dimensions = {
    topic: scoreTopic(brief, haystack),
    platform: scorePlatform(brief, creator),
    followerFit: scoreFollowerFit(brief, creator),
    evidenceQuality: scoreEvidenceQuality(creator),
    brandSafety: scoreBrandSafety(brief, haystack)
  };

  const score = Math.max(0, Math.min(100, Object.values(dimensions).reduce((sum, value) => sum + value, 0)));
  const matchedKeywords = brief.creatorKeywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
  const concerns = [];
  const missingData = [];

  if (!creator.metrics?.followers) {
    concerns.push("缺少粉丝量数据");
    missingData.push("followers");
  }
  if (!creator.bio) {
    concerns.push("缺少主页简介");
    missingData.push("bio");
  }

  return {
    briefId: brief.id || "brief:adhoc",
    score,
    level: score >= 75 ? "high" : score >= 50 ? "medium" : "low",
    provider: "rules-v1",
    reasons: buildReasons(brief, creator, matchedKeywords, dimensions),
    concerns,
    matchedKeywords,
    missingData,
    dimensions,
    evaluatedAt: Date.now()
  };
}

function scoreTopic(brief, haystack) {
  if (!brief.creatorKeywords.length) return 18;
  const hits = brief.creatorKeywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).length;
  return Math.min(35, hits * 12);
}

function scorePlatform(brief, creator) {
  if (!brief.platforms.length) return 12;
  return brief.platforms.includes(creator.platform) ? 15 : 0;
}

function scoreFollowerFit(brief, creator) {
  const followers = creator.metrics?.followers;
  if (!followers) return 8;
  const min = brief.followerRange.min;
  const max = brief.followerRange.max;
  if (min && followers < min) return 8;
  if (max && followers > max) return 10;
  return 20;
}

function scoreEvidenceQuality(creator) {
  let score = 0;
  if (creator.discovery?.kind === "profile") score += 8;
  if (creator.discovery?.kind === "x-post-author") score += 6;
  if (creator.discovery?.kind === "web-search") score += 8;
  if (creator.discovery?.kind === "third-party-search") score += 8;
  if (creator.discovery?.evidenceText) score += 3;
  if (creator.avatarUrl) score += 3;
  if (creator.bio) score += 4;
  return Math.min(score, 15);
}

function scoreBrandSafety(brief, haystack) {
  const hasExcluded = brief.excludeKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
  if (hasExcluded) return 0;
  if (/(giveaway|airdrop|博彩|成人|抽奖|擦边|互关|do not follow|不要关注|deadlykalesh|gharkekalesh)/i.test(haystack)) {
    return 0;
  }
  if (/(official|store|shop|brand|shein|news|shopping|官网|旗舰店|官方|新闻)/i.test(haystack)) {
    return 3;
  }
  return 10;
}

function buildReasons(brief, creator, matchedKeywords, dimensions) {
  const reasons = [];
  if (matchedKeywords.length) reasons.push(`内容命中 ${matchedKeywords.slice(0, 4).join(" / ")}`);
  if (dimensions.platform > 0) reasons.push(`平台符合 ${creator.platform.toUpperCase()}`);
  if (creator.metrics?.followers) reasons.push("粉丝量可用于区间判断");
  if (creator.discovery?.summary) reasons.push(creator.discovery.summary);
  return reasons.length ? reasons : ["候选信息较少，建议结合主页公开资料判断"];
}

function parseRawBrief(text) {
  const lower = text.toLowerCase();
  const platforms = ["x", "youtube", "tiktok", "instagram", "linkedin"].filter((platform) => lower.includes(platform));
  const excludeKeywords = unique([
    ...["crypto", "politics", "giveaway", "博彩", "成人"].filter((keyword) => lower.includes(keyword.toLowerCase())),
    ...extractExplicitExcludeTerms(lower)
  ]);
  const creatorKeywords = extractKeywords(lower);
  const expandedCreatorKeywords = expandCreatorKeywords(creatorKeywords, lower);
  const followerRange = parseFollowerRange(lower);
  return { platforms, excludeKeywords, creatorKeywords: expandedCreatorKeywords, followerRange };
}

function extractKeywords(text) {
  const dictionary = [
    "beauty",
    "asian",
    "female",
    "woman",
    "blogger",
    "creator",
    "influencer",
    "coser",
    "cosplay",
    "cosplayer",
    "skincare",
    "makeup",
    "saas",
    "ai",
    "startup",
    "ecommerce",
    "fitness",
    "gaming",
    "travel",
    "food",
    "review",
    "founder",
    "newsletter",
    "tutorial",
    "教程",
    "测评",
    "亚洲",
    "亚洲女",
    "女性",
    "cos",
    "coser",
    "cosplay",
    "coser博主",
    "二次元",
    "角色扮演",
    "美妆",
    "美妆博主",
    "护肤",
    "跨境",
    "独立站",
    "创业",
    "科技"
  ];
  return dictionary.filter((keyword) => text.includes(keyword.toLowerCase()));
}

function expandCreatorKeywords(keywords, text) {
  const expanded = [...keywords];
  if (/美妆|护肤|beauty|makeup|skincare/.test(text)) {
    expanded.push("beauty", "makeup", "skincare", "美妆", "护肤");
  }
  if (/亚洲|asian/.test(text)) expanded.push("asian", "亚洲");
  if (/女|女性|woman|women|female/.test(text)) expanded.push("female", "woman", "women", "女性");
  if (/coser|cosplay|cosplayer|二次元|角色扮演|\bcos\b/i.test(text)) {
    expanded.push("coser", "cosplay", "cosplayer", "二次元", "角色扮演");
  }
  if (/博主|达人|creator|influencer|blogger|kol/.test(text)) {
    expanded.push("blogger", "creator", "influencer", "博主");
  }
  return unique(expanded).slice(0, 16);
}

function buildPositiveSearchTerms(brief, negativeTerms = []) {
  const negativeSet = new Set(negativeTerms);
  return unique([
    ...brief.creatorKeywords,
    ...extractFreeformSearchTerms(brief.rawText),
    ...inferPersonaTerms(brief.rawText)
  ])
    .filter((term) => !negativeSet.has(term))
    .slice(0, 9);
}

function buildNegativeSearchTerms(brief) {
  return unique([
    ...brief.excludeKeywords,
    ...extractExplicitExcludeTerms(brief.rawText.toLowerCase())
  ]).slice(0, 6);
}

function buildSearchQuery(positiveTerms, negativeTerms) {
  const positive = positiveTerms.length ? positiveTerms : ["creator"];
  const negative = negativeTerms.map((term) => `-${quoteSearchTerm(term)}`);
  return [...positive.map(quoteSearchTerm), ...negative].join(" ");
}

function quoteSearchTerm(term) {
  return /\s/.test(term) ? `"${term.replaceAll('"', "")}"` : term;
}

function extractFreeformSearchTerms(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@\w{1,15}/g, " ")
    .replace(/\d+(?:\.\d+)?\s*([kKmM万千]?)\s*[-~到至]\s*\d+(?:\.\d+)?\s*([kKmM万千]?)/g, " ");

  return (normalized.match(/[a-z0-9+#.]{2,32}|[\u4e00-\u9fff]{2,12}/g) || [])
    .map(cleanSearchTerm)
    .filter((term) => term && !SEARCH_STOPWORDS.has(term));
}

function cleanSearchTerm(term) {
  return String(term || "")
    .replace(/(相关)?创作者$/u, "")
    .replace(/(相关)?达人$/u, "")
    .replace(/相关$/u, "")
    .trim();
}

function inferPersonaTerms(text) {
  const lower = String(text || "").toLowerCase();
  const terms = [];

  if (/founder|创始|创业/.test(lower)) terms.push("founder");
  if (/review|测评|评测/.test(lower)) terms.push("review");
  if (/tutorial|教程|教学/.test(lower)) terms.push("tutorial");
  if (/newsletter|substack/.test(lower)) terms.push("newsletter");
  if (/coser|cosplay|cosplayer|二次元|角色扮演|\bcos\b/i.test(lower)) terms.push("coser", "cosplay", "cosplayer");
  if (!terms.length && /creator|influencer|kol|达人|博主|创作者/.test(lower)) terms.push("creator");

  return terms;
}

function extractExplicitExcludeTerms(text) {
  const terms = [];
  const pattern = /(?:exclude|excluding|排除|不要|不看)\s*[:：]?\s*([a-z0-9+#.,\s/、，和以及-]{2,80})/gi;
  for (const match of text.matchAll(pattern)) {
    terms.push(
      ...(match[1].match(/[a-z0-9+#.]{2,32}|[\u4e00-\u9fff]{2,12}/g) || [])
        .map(cleanSearchTerm)
        .filter((term) => term && !SEARCH_STOPWORDS.has(term))
    );
  }
  return terms;
}

function extractDirectProfiles(text, platform) {
  if (platform !== "x") return [];

  const handles = new Set();
  const rawText = String(text || "");

  for (const match of rawText.matchAll(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/g)) {
    handles.add(`@${match[1]}`);
  }

  for (const match of rawText.matchAll(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})(?=$|[^A-Za-z0-9_])/g)) {
    handles.add(`@${match[2]}`);
  }

  return [...handles];
}

function normalizeSearchPlatform(platform) {
  const normalized = String(platform || "x").toLowerCase();
  if (normalized === "twitter") return "x";
  return normalized;
}

function buildSearchNotes(brief) {
  const notes = ["这是辅助搜索计划；主流程应优先使用 /api/discover/creators 返回已筛选排序的 OP 列表。"];
  if (brief.followerRange.min || brief.followerRange.max) {
    notes.push("粉丝区间无法可靠编码进 X 搜索 URL，但 discover 管线会在数据源返回指标后参与评分。");
  }
  return notes;
}

function parseFollowerRange(text) {
  const range = { min: null, max: null };
  const match = text.match(/(\d+(?:\.\d+)?)\s*([kKmM万千]?)\s*[-~到至]\s*(\d+(?:\.\d+)?)\s*([kKmM万千]?)/);
  if (!match) return range;

  range.min = toNumber(match[1], match[2]);
  range.max = toNumber(match[3], match[4]);
  return range;
}

function toNumber(value, unit) {
  const multipliers = { k: 1_000, m: 1_000_000, 千: 1_000, 万: 10_000 };
  return Math.round(Number(value) * (multipliers[String(unit).toLowerCase()] || multipliers[unit] || 1));
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).toLowerCase()))];
}

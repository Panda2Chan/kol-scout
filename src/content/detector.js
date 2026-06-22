(function registerDetector() {
  const KNOWN_PLATFORMS = [
    {
      platform: "x",
      hosts: ["x.com", "twitter.com"],
      handlePattern: /^\/([A-Za-z0-9_]{1,15})(?:\/|$)/,
      blockedHandles: [
        "home",
        "explore",
        "notifications",
        "messages",
        "i",
        "search",
        "settings",
        "compose",
        "hashtag",
        "intent",
        "privacy",
        "tos"
      ]
    },
    {
      platform: "youtube",
      hosts: ["youtube.com", "www.youtube.com", "m.youtube.com"],
      handlePattern: /^\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+)\/?/
    },
    {
      platform: "tiktok",
      hosts: ["tiktok.com", "www.tiktok.com"],
      handlePattern: /^\/(@[^/?#]+)\/?/
    },
    {
      platform: "instagram",
      hosts: ["instagram.com", "www.instagram.com"],
      handlePattern: /^\/([^/?#]+)\/?$/,
      blockedHandles: ["p", "reel", "explore", "accounts", "direct"]
    },
    {
      platform: "linkedin",
      hosts: ["linkedin.com", "www.linkedin.com"],
      handlePattern: /^\/(in\/[^/?#]+|company\/[^/?#]+)\/?/
    }
  ];

  async function scan() {
    const source = {
      pageUrl: location.href,
      pageTitle: document.title,
      capturedAt: Date.now()
    };

    const currentProfile = getCurrentProfile();
    await waitForProfileData(currentProfile);

    const currentCandidate = detectCurrentProfile(source);
    const candidates = [
      currentCandidate,
      ...detectPageCreators(source, currentCandidate)
    ].filter(Boolean);

    return dedupeCandidates(candidates);
  }

  function detectCurrentProfile(source) {
    const currentProfile = getCurrentProfile();
    const { rule, handle, url } = currentProfile;
    if (!rule) return detectWebsiteProfile(source);
    if (!handle) return null;

    return {
      id: `${rule.platform}:${handle}`.toLowerCase(),
      platform: rule.platform,
      name: readName(rule.platform, handle),
      handle,
      profileUrl: cleanProfileUrl(url, rule, handle),
      avatarUrl: readAvatar(),
      bio: readBio(rule.platform),
      metrics: readMetrics(rule.platform, handle),
      discovery: {
        kind: "profile",
        confidence: 96,
        summary: "当前打开的是创作者主页，已尝试读取主页可见数据。",
        evidenceText: "",
        needsEnrichment: false
      },
      enrichment: {
        status: "page",
        provider: "dom"
      },
      source
    };
  }

  function getCurrentProfile() {
    const url = new URL(location.href);
    const rule = getPlatformRule(url);
    const handle = rule ? extractHandle(url, rule) : "";
    return { url, rule, handle };
  }

  async function waitForProfileData(currentProfile) {
    if (!currentProfile.rule || !currentProfile.handle) return;

    const startedAt = Date.now();
    while (Date.now() - startedAt < 2500) {
      if (hasProfileSignals(currentProfile.rule.platform, currentProfile.handle)) return;
      await delay(150);
    }
  }

  function hasProfileSignals(platform, handle) {
    if (platform === "x") {
      return Boolean(
        document.querySelector('[data-testid="UserName"]') &&
          (document.querySelector('[data-testid="UserDescription"]') ||
            firstText([
              `a[href$="/${handle.replace(/^@/, "")}/verified_followers"]`,
              `a[href*="/${handle.replace(/^@/, "")}/verified_followers"]`
            ]))
      );
    }

    if (platform === "youtube") {
      return Boolean(document.querySelector("h1") && firstText(["#subscriber-count", "#description"]));
    }

    if (platform === "tiktok") {
      return Boolean(document.querySelector('[data-e2e="user-title"]'));
    }

    if (platform === "instagram") {
      return Boolean(document.querySelector("header"));
    }

    return Boolean(document.body.innerText.length > 500);
  }

  function detectWebsiteProfile(source) {
    const author =
      queryMeta("author") ||
      queryMeta("article:author") ||
      document.querySelector('[rel="author"]')?.textContent?.trim();

    if (!author) return null;

    return {
      platform: "website",
      name: author,
      handle: "",
      profileUrl: location.href,
      avatarUrl: readAvatar(),
      bio: readDescription(),
      metrics: {},
      discovery: {
        kind: "website",
        confidence: 68,
        summary: "从当前网页作者信息识别。",
        evidenceText: "",
        needsEnrichment: true
      },
      enrichment: {
        status: "pending",
        provider: "local"
      },
      source
    };
  }

  function detectPageCreators(source, currentCandidate) {
    const currentHost = location.hostname.replace(/^www\./, "");
    if (currentHost === "x.com" || currentHost === "twitter.com") {
      return detectXCreators(source, currentCandidate);
    }

    return detectSocialLinks(source, currentCandidate);
  }

  function detectXCreators(source, currentCandidate) {
    const contexts = [
      ...document.querySelectorAll('article, [data-testid="UserCell"], [data-testid="cellInnerDiv"]')
    ];
    const candidates = [];

    for (const context of contexts) {
      candidates.push(...detectXCreatorsFromContext(context, source));
    }

    candidates.push(...detectSocialLinks(source, currentCandidate));

    return candidates
      .filter((candidate) => candidate?.platform === "x")
      .filter((candidate) => !currentCandidate || candidate.id !== currentCandidate.id);
  }

  function detectXCreatorsFromContext(context, source) {
    const profileLinks = [...context.querySelectorAll('a[href^="/"], a[href^="https://x.com/"], a[href^="https://twitter.com/"]')]
      .map((link) => ({ link, candidate: candidateFromLink(link, source, context) }))
      .filter(({ candidate }) => candidate?.platform === "x");

    const byId = new Map();
    for (const { link, candidate } of profileLinks) {
      const contextCandidate = enrichCandidateFromXContext(candidate, context, link);
      const previous = byId.get(contextCandidate.id);
      byId.set(contextCandidate.id, mergeBestCandidate(previous, contextCandidate));
    }

    return [...byId.values()];
  }

  function detectSocialLinks(source, currentCandidate) {
    return [...document.querySelectorAll("a[href]")]
      .map((link) => candidateFromLink(link, source))
      .filter((candidate) => !currentCandidate || candidate?.id !== currentCandidate.id)
      .filter(Boolean);
  }

  function candidateFromLink(link, source, context = link) {
    try {
      const url = new URL(link.href, location.href);
      const rule = getPlatformRule(url);
      if (!rule) return null;

      const handle = extractHandle(url, rule);
      if (!handle) return null;

      const label = link.textContent?.trim() || link.getAttribute("aria-label") || handle;
      const evidenceText = normalizeText(context.innerText || link.textContent || "").slice(0, 280);
      return {
        id: `${rule.platform}:${handle}`.toLowerCase(),
        platform: rule.platform,
        name: cleanCandidateName(normalizeText(label), handle).slice(0, 80) || handle,
        handle,
        profileUrl: cleanProfileUrl(url, rule, handle),
        avatarUrl: findAvatarNearLink(link, context),
        bio: "",
        metrics: {},
        discovery: {
          kind: "page-link",
          confidence: 56,
          summary: "从当前页面可见社媒链接识别，可结合全站匹配获取公开资料。",
          evidenceText,
          needsEnrichment: true
        },
        enrichment: {
          status: "pending",
          provider: "local"
        },
        source
      };
    } catch {
      return null;
    }
  }

  function enrichCandidateFromXContext(candidate, context, link) {
    const rawHandle = candidate.handle.replace(/^@/, "");
    const kind = context.matches("article") ? "x-post-author" : "x-visible-profile";
    const name = readXNameFromContext(context, rawHandle) || candidate.name;

    return {
      ...candidate,
      name: cleanCandidateName(name, candidate.handle),
      avatarUrl: findAvatarNearLink(link, context) || candidate.avatarUrl,
      metrics: {
        ...candidate.metrics,
        ...readXPostMetrics(context)
      },
      discovery: {
        kind,
        confidence: kind === "x-post-author" ? 82 : 74,
        summary: kind === "x-post-author"
          ? "从当前 X 页面可见帖子作者识别。"
          : "从当前 X 页面可见推荐/用户卡识别。",
        evidenceText: normalizeText(context.innerText).slice(0, 500),
        needsEnrichment: true
      },
      enrichment: {
        status: "pending",
        provider: "local"
      }
    };
  }

  function getPlatformRule(url) {
    const host = url.hostname.replace(/^www\./, "");
    return KNOWN_PLATFORMS.find((rule) =>
      rule.hosts.some((knownHost) => host === knownHost.replace(/^www\./, ""))
    );
  }

  function extractHandle(url, rule) {
    const match = url.pathname.match(rule.handlePattern);
    if (!match) return "";

    const raw = match[1].replace(/\/$/, "");
    const handle = raw.startsWith("@") || raw.includes("/") ? raw : `@${raw}`;
    const normalized = handle.toLowerCase().replace(/^@/, "");

    if (rule.platform === "x" && !/^@?[A-Za-z0-9_]{1,15}$/.test(handle)) return "";
    if (rule.blockedHandles?.includes(normalized)) return "";
    return handle;
  }

  function cleanProfileUrl(url, rule, handle) {
    const host = url.hostname;
    const rawHandle = handle.replace(/^@/, "");
    const prefixedHandle = handle.startsWith("@") ? handle : `@${handle}`;
    const path = ["youtube", "tiktok"].includes(rule.platform)
      ? `/${prefixedHandle}`
      : `/${rawHandle}`;
    return `${url.protocol}//${host}${path}`;
  }

  function readName(platform, fallback) {
    const selectorsByPlatform = {
      x: ['[data-testid="UserName"] span', '[data-testid="UserName"]'],
      youtube: ["#channel-name #text", "ytd-channel-name #text", "h1"],
      tiktok: ['[data-e2e="user-title"]', '[data-e2e="user-subtitle"]', "h1"],
      instagram: ["header h2", "header h1", "h1"],
      linkedin: ["main h1", ".text-heading-xlarge", "h1"]
    };

    return (
      firstText(selectorsByPlatform[platform] || []) ||
      cleanTitle(queryMeta("og:title") || document.title, platform) ||
      firstText(["h1"]) ||
      fallback
    );
  }

  function readBio(platform) {
    const selectorsByPlatform = {
      x: ['[data-testid="UserDescription"]'],
      youtube: [
        "#description-container",
        "#description",
        "yt-attributed-string#description",
        "ytd-channel-about-metadata-renderer #description"
      ],
      tiktok: ['[data-e2e="user-bio"]', '[data-e2e="user-subtitle"]'],
      instagram: ["header section div span", "main header span"],
      linkedin: [".text-body-medium.break-words", "section.pv-about-section"]
    };

    const platformBio = firstText(selectorsByPlatform[platform] || []);
    if (isUsefulBio(platformBio)) return platformBio;

    const jsonBio = readBioFromScripts(platform);
    if (isUsefulBio(jsonBio)) return jsonBio;

    return cleanBioFromDescription(readDescription(), platform);
  }

  function readDescription() {
    return normalizeText(queryMeta("description") || queryMeta("og:description") || "");
  }

  function readAvatar() {
    const image =
      queryMeta("og:image") ||
      document.querySelector('[data-testid="UserAvatar-Container-unknown"] img')?.src ||
      document.querySelector('img[alt*="avatar" i]')?.src ||
      document.querySelector('img[alt*="profile" i]')?.src;

    return image || "";
  }

  function readMetrics(platform, handle) {
    const text = collectMetricText(platform, handle);
    return {
      followers: readFollowers(platform, text, handle),
      following: parseMetric(text, ["following", "正在关注", "关注中"]),
      likes: parseMetric(text, ["likes", "获赞", "喜欢"]),
      posts: parseMetric(text, ["posts", "帖子", "videos", "视频", "作品"])
    };
  }

  function readFollowers(platform, text, handle) {
    const platformSelectors = {
      x: [
        `a[href$="/${handle.replace(/^@/, "")}/verified_followers"]`,
        `a[href*="/${handle.replace(/^@/, "")}/verified_followers"]`,
        'a[href$="/followers"]',
        'a[href*="/followers"]'
      ],
      youtube: ["#subscriber-count", "yt-formatted-string#subscriber-count"],
      tiktok: ['[data-e2e="followers-count"]'],
      instagram: ['a[href$="/followers/"] span', "header section ul li span"],
      linkedin: ['a[href*="followers"]', ".pvs-header__subtitle"]
    };

    const selectorMetric = parseNumberFromText(firstText(platformSelectors[platform] || []));
    if (selectorMetric) return selectorMetric;

    return parseMetric(text, [
      "followers",
      "follower",
      "关注者",
      "粉丝",
      "位粉丝",
      "位关注者",
      "subscribers",
      "subscriber",
      "订阅者",
      "位订阅者",
      "訂閱者"
    ]);
  }

  function readXNameFromContext(context, rawHandle) {
    const lines = (context.innerText || "")
      .split("\n")
      .map((line) => normalizeText(line))
      .filter(Boolean);
    const handleIndex = lines.findIndex((line) => line.toLowerCase() === `@${rawHandle}`.toLowerCase());

    if (handleIndex > 0) {
      const name = lines
        .slice(Math.max(0, handleIndex - 4), handleIndex)
        .reverse()
        .find((line) => isLikelyCreatorName(line));
      if (name) return name;
    }

    return "";
  }

  function readXPostMetrics(context) {
    if (!context.matches("article")) return {};
    const text = normalizeText(context.innerText);
    return {
      likes: parseMetric(text, ["likes", "Likes", "赞"]),
      posts: 1
    };
  }

  function findAvatarNearLink(link, context) {
    const image =
      link.querySelector("img") ||
      context.querySelector('[data-testid="Tweet-User-Avatar"] img') ||
      context.querySelector('img[src*="profile_images"]') ||
      context.querySelector("img");

    return image?.src || "";
  }

  function cleanCandidateName(name, handle) {
    return normalizeText(name)
      .replace(handle, "")
      .replace("Verified account", "")
      .replace("Follow", "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isLikelyCreatorName(text) {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    if (normalized.startsWith("@")) return false;
    if (/^(follow|following|verified account|promoted|ad)$/i.test(normalized)) return false;
    if (/^\d/.test(normalized)) return false;
    return normalized.length <= 80;
  }

  function parseMetric(text, labels) {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const before = new RegExp(`([\\d,.]+)\\s*([KMB万亿千百]?)\\s*${escaped}`, "i").exec(text);
      const after = new RegExp(`${escaped}\\s*([\\d,.]+)\\s*([KMB万亿千百]?)`, "i").exec(text);
      const match = before || after;
      if (match) return toNumber(match[1], match[2]);
    }
    return null;
  }

  function toNumber(value, unit) {
    const base = Number(String(value).replaceAll(",", ""));
    if (Number.isNaN(base)) return null;

    const multipliers = {
      K: 1_000,
      M: 1_000_000,
      B: 1_000_000_000,
      百: 100,
      千: 1_000,
      万: 10_000,
      亿: 100_000_000
    };

    return Math.round(base * (multipliers[unit] || 1));
  }

  function queryMeta(name) {
    return (
      document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ||
      document.querySelector(`meta[property="${name}"]`)?.getAttribute("content") ||
      ""
    );
  }

  function collectMetricText(platform, handle) {
    const pieces = [
      document.body.innerText,
      document.body.getAttribute("aria-label"),
      queryMeta("description"),
      queryMeta("og:description"),
      queryMeta("twitter:description"),
      ...[...document.querySelectorAll("[aria-label]")]
        .slice(0, 500)
        .map((node) => node.getAttribute("aria-label")),
      readJsonMetricText(platform, handle)
    ];

    return normalizeText(pieces.filter(Boolean).join(" ")).slice(0, 80000);
  }

  function readJsonMetricText(platform, handle) {
    const scripts = getScriptText();
    const texts = [];
    const rawHandle = handle?.replace(/^@/, "");

    for (const script of scripts) {
      if (platform === "youtube") {
        texts.push(...matchAll(script, /"subscriberCountText":\{"simpleText":"([^"]+)"/g));
        texts.push(...matchAll(script, /"subscriberCountText":\{"runs":\[\{"text":"([^"]+)"/g));
      }

      if (platform === "instagram" || platform === "tiktok") {
        texts.push(...matchAll(script, /"edge_followed_by":\{"count":(\d+)/g));
        texts.push(...matchAll(script, /"followerCount":(\d+)/g));
        texts.push(...matchAll(script, /"fans":(\d+)/g));
      }

      if (platform === "x" && rawHandle && script.includes(rawHandle)) {
        texts.push(...matchAll(script, /"followers_count":(\d+)/g));
        texts.push(...matchAll(script, /"normal_followers_count":(\d+)/g));
      }
    }

    return texts.map((text) => `${text} followers`).join(" ");
  }

  function readBioFromScripts(platform) {
    const patterns = {
      x: [/"description":"((?:\\.|[^"\\])*)"/g],
      youtube: [
        /"description":\{"simpleText":"((?:\\.|[^"\\])*)"/g,
        /"attributedDescriptionBodyText":\{"content":"((?:\\.|[^"\\])*)"/g
      ],
      tiktok: [/"signature":"((?:\\.|[^"\\])*)"/g],
      instagram: [/"biography":"((?:\\.|[^"\\])*)"/g],
      linkedin: [/"summary":"((?:\\.|[^"\\])*)"/g]
    };

    for (const script of getScriptText()) {
      for (const pattern of patterns[platform] || []) {
        const match = pattern.exec(script);
        if (!match) continue;

        const decoded = decodeJsonString(match[1]);
        if (isUsefulBio(decoded)) return decoded;
      }
    }

    return "";
  }

  function cleanBioFromDescription(description, platform) {
    const text = normalizeText(description);
    if (!text) return "";

    if (platform === "instagram") {
      const quoted = text.match(/[“"]([^”"]{10,220})[”"]/);
      if (quoted) return normalizeText(quoted[1]);
    }

    return text
      .replace(/^\d[\d,.]*\s*[KMB万亿千百]?\s+(followers|粉丝|关注者|subscribers|订阅者).*?-\s*/i, "")
      .slice(0, 240);
  }

  function cleanTitle(title, platform) {
    const text = normalizeText(title);
    if (!text) return "";

    if (platform === "x") return text.replace(/\s*\(@[^)]+\).*/, "");
    if (platform === "youtube") return text.replace(/\s*-\s*YouTube.*/, "");
    if (platform === "instagram") return text.replace(/\s*•\s*Instagram.*/, "");
    if (platform === "tiktok") return text.replace(/\s+on TikTok.*/, "");
    return text;
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = normalizeText(node?.innerText || node?.textContent || node?.getAttribute?.("title"));
      if (text) return text;
    }
    return "";
  }

  function parseNumberFromText(text) {
    const match = normalizeText(text).match(/([\d,.]+)\s*([KMB万亿千百]?)/i);
    if (!match) return null;
    return toNumber(match[1], match[2]);
  }

  function isUsefulBio(text) {
    const normalized = normalizeText(text);
    if (normalized.length < 8) return false;
    if (/^(followers|following|关注|粉丝|订阅|posts|likes)$/i.test(normalized)) return false;
    return true;
  }

  function getScriptText() {
    return [...document.scripts]
      .map((script) => script.textContent || "")
      .filter(Boolean)
      .slice(0, 80);
  }

  function matchAll(text, pattern) {
    return [...text.matchAll(pattern)].map((match) => decodeJsonString(match[1]));
  }

  function decodeJsonString(value) {
    const raw = String(value || "");
    if (/^\d+$/.test(raw)) return raw;

    try {
      return normalizeText(JSON.parse(`"${raw.replaceAll('"', '\\"')}"`));
    } catch {
      return normalizeText(raw.replaceAll("\\n", " ").replaceAll('\\"', '"'));
    }
  }

  function dedupeCandidates(candidates) {
    const byId = new Map();
    for (const candidate of candidates) {
      if (!candidate.profileUrl) continue;

      const key = candidate.id || candidate.profileUrl;
      const previous = byId.get(key);
      byId.set(key, mergeBestCandidate(previous, candidate));
    }
    return [...byId.values()].slice(0, 30);
  }

  function mergeBestCandidate(previous, candidate) {
    if (!previous) return candidate;

    const winner =
      scoreCandidateCompleteness(candidate) > scoreCandidateCompleteness(previous)
        ? candidate
        : previous;
    const fallback = winner === candidate ? previous : candidate;

    return {
      ...fallback,
      ...winner,
      name: winner.name || fallback.name,
      avatarUrl: winner.avatarUrl || fallback.avatarUrl,
      bio: winner.bio || fallback.bio,
      metrics: {
        followers: winner.metrics?.followers ?? fallback.metrics?.followers ?? null,
        following: winner.metrics?.following ?? fallback.metrics?.following ?? null,
        likes: winner.metrics?.likes ?? fallback.metrics?.likes ?? null,
        posts: winner.metrics?.posts ?? fallback.metrics?.posts ?? null
      },
      discovery: mergeDiscovery(fallback.discovery, winner.discovery),
      enrichment: winner.enrichment || fallback.enrichment
    };
  }

  function mergeDiscovery(previous = {}, current = {}) {
    const surfaces = new Set([
      ...(previous.surfaces || []),
      ...(current.surfaces || []),
      previous.kind,
      current.kind
    ].filter(Boolean));

    const seenCount = Math.max(previous.seenCount || 1, current.seenCount || 1) +
      (previous.kind && current.kind ? 1 : 0);

    return {
      ...previous,
      ...current,
      confidence: Math.max(previous.confidence || 0, current.confidence || 0),
      seenCount,
      surfaces: [...surfaces],
      evidenceText: current.evidenceText || previous.evidenceText || "",
      needsEnrichment: current.needsEnrichment ?? previous.needsEnrichment ?? true
    };
  }

  function scoreCandidateCompleteness(candidate) {
    let score = 0;
    if (candidate.name) score += 2;
    if (candidate.handle) score += 2;
    if (candidate.profileUrl) score += 2;
    if (candidate.avatarUrl) score += 3;
    if (candidate.bio) score += 4;
    if (candidate.metrics?.followers) score += 5;
    if (candidate.metrics?.following) score += 1;
    if (candidate.metrics?.likes) score += 1;
    if (candidate.metrics?.posts) score += 1;
    return score;
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/https?:\/\/\s+/gi, "https://")
      .replace(/\s+/g, " ")
      .trim();
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  window.__KOL_LITE_DETECTOR__ = { scan };

  if (location.href.includes("/test-fixtures/")) {
    window.__KOL_LITE_DETECTOR__.debug = {
      parseMetric,
      readMetrics,
      readBio,
      toNumber,
      dedupeCandidates,
      scoreCandidateCompleteness
    };
  }
})();

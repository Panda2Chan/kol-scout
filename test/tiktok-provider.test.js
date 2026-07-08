import test from "node:test";
import assert from "node:assert/strict";
import { tiktokProvider, __testing } from "../backend/platforms/tiktok-provider.js";

test("TikTok profile URLs normalize handles and reject reserved paths", () => {
  assert.equal(tiktokProvider.buildProfileUrl("@beauty.creator"), "https://www.tiktok.com/@beauty.creator");
  assert.equal(tiktokProvider.buildProfileUrl("search"), "");
  assert.equal(tiktokProvider.buildProfileUrl(".bad"), "");
});

test("TikTok AI search queries remove X site operators and avoid duplicated TikTok operators", () => {
  const fromX = __testing.buildAiSearchQuery("site:x.com beauty creator", "United States", ["-shop"]);
  const fromTikTok = __testing.buildAiSearchQuery("site:tiktok.com/@ skincare review", "", []);

  assert.equal(fromX, "site:tiktok.com/@ beauty creator United States -shop");
  assert.equal(fromTikTok, "site:tiktok.com/@ skincare review");
});

test("TikTok search queries include AI hints and hashtag expansions", () => {
  const queries = __testing.buildSearchQueries({
    query: "beauty creator",
    positiveTerms: ["beauty", "review"],
    negativeTerms: ["shop"],
    aiSearch: {
      queries: ["site:x.com skincare creator"]
    },
    normalizedBrief: {
      rawText: "TikTok beauty review creator"
    }
  }, { country: "US" });

  assert.ok(queries.some((query) => query.includes("site:tiktok.com/@ skincare creator")));
  assert.ok(queries.every((query) => !query.includes("site:x.com")));
  assert.ok(queries.some((query) => query.includes("#beauty")));
});

test("Discovery diagnostics attach as non-enumerable array metadata", () => {
  const creators = [{ handle: "@one" }];
  const meta = { rawFetched: 10 };
  const attached = __testing.attachDiscoveryMeta(creators, meta);

  assert.equal(attached.discoveryMeta, meta);
  assert.deepEqual(Object.keys(attached), ["0"]);
});

test("TikTok concurrency helpers split work and prioritize stronger candidates", () => {
  assert.deepEqual(__testing.chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);

  const weak = {
    tags: ["beauty"],
    metrics: { followers: null },
    discovery: { kind: "web-search", relevanceScore: 10 },
    contact: {}
  };
  const strong = {
    tags: ["beauty", "review", "skincare"],
    metrics: { followers: 120000 },
    discovery: { kind: "profile", relevanceScore: 45 },
    contact: { email: "hello@example.com" }
  };

  assert.ok(__testing.candidatePriority(strong) > __testing.candidatePriority(weak));
});

test("TikTok search sources prioritize Jina when configured", () => {
  const previousEnv = snapshotEnv(["JINA_API_KEY", "TAVILY_API_KEY", "SERPER_API_KEY", "BRAVE_SEARCH_API_KEY"]);
  try {
    process.env.JINA_API_KEY = "jina_test";
    process.env.TAVILY_API_KEY = "tavily_test";
    process.env.SERPER_API_KEY = "serper_test";
    process.env.BRAVE_SEARCH_API_KEY = "brave_test";

    assert.deepEqual(__testing.buildSearchSources().map((source) => source.name), [
      "jina-search",
      "tavily",
      "serper",
      "brave",
      "yahoo-web-search"
    ]);
    assert.deepEqual(
      __testing.buildSearchSourceGroups(__testing.buildSearchSources(), 3).map((group) =>
        group.map((source) => source.name)
      ),
      [
        ["jina-search"],
        ["tavily", "serper", "brave"],
        ["yahoo-web-search"]
      ]
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("Jina search probes quota before the real search and logs remaining quota", async () => {
  const previousEnv = snapshotEnv(["JINA_API_KEY", "JINA_QUOTA_PROBE_ENABLED"]);
  const previousFetch = global.fetch;
  const calls = [];
  const logs = [];
  try {
    process.env.JINA_API_KEY = "jina_test";
    delete process.env.JINA_QUOTA_PROBE_ENABLED;
    global.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response("", {
          status: 200,
          headers: {
            "X-RateLimit-Remaining-Requests": "10",
            "X-RateLimit-Remaining-Tokens": "1000"
          }
        });
      }
      return new Response("1. [Creator](https://www.tiktok.com/@one) - creator", {
        status: 200,
        headers: {
          "X-RateLimit-Remaining-Requests": "9"
        }
      });
    };

    const pages = await __testing.fetchJinaSearchPages("site:tiktok.com/@ creator", null, createTestLogger(logs));

    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("s.jina.ai"));
    assert.deepEqual(pages, ["1. [Creator](https://www.tiktok.com/@one) - creator"]);
    assert.ok(logs.some((entry) =>
      entry.level === "info"
      && entry.event === "jina_quota.probe_ok"
      && entry.fields.rateLimit["x-ratelimit-remaining-requests"] === "10"
    ));
    assert.ok(logs.some((entry) => entry.event === "jina_search.rate_limit"));
  } finally {
    global.fetch = previousFetch;
    restoreEnv(previousEnv);
  }
});

test("Jina quota probe warns and skips the real search when quota is insufficient", async () => {
  const previousEnv = snapshotEnv(["JINA_API_KEY", "JINA_QUOTA_PROBE_ENABLED"]);
  const previousFetch = global.fetch;
  const calls = [];
  const logs = [];
  try {
    process.env.JINA_API_KEY = "jina_test";
    delete process.env.JINA_QUOTA_PROBE_ENABLED;
    global.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        code: "AUTHZ_INSUFFICIENT_BALANCE",
        message: "balance exhausted"
      }), { status: 403 });
    };

    await assert.rejects(
      __testing.fetchJinaSearchPages("site:tiktok.com/@ creator", null, createTestLogger(logs)),
      (error) =>
        error.name === "JinaApiError"
        && error.statusCode === 403
        && error.code === "AUTHZ_INSUFFICIENT_BALANCE"
        && /额度不足/.test(error.message)
    );

    assert.equal(calls.length, 1);
    assert.ok(logs.some((entry) =>
      entry.level === "warn"
      && entry.event === "jina_quota.insufficient"
      && entry.fields.code === "AUTHZ_INSUFFICIENT_BALANCE"
    ));
  } finally {
    global.fetch = previousFetch;
    restoreEnv(previousEnv);
  }
});

test("TikTok fallback search failure message reports local search timeout without claiming global timeout", () => {
  const message = __testing.buildFallbackSearchFailureMessage({
    queryCount: 8,
    sources: [
      { source: "jina-search", queriesTried: 4, rawResults: 0, profileCandidates: 0, parsedCandidates: 0 },
      { source: "yahoo-web-search", queriesTried: 4, rawResults: 0, profileCandidates: 0, parsedCandidates: 0 }
    ]
  }, 101_000, [
    "jina-search:The operation was aborted due to timeout",
    "yahoo-web-search:TimeoutError"
  ]);

  assert.match(message, /已尝试 2 个搜索源、8 次查询/);
  assert.match(message, /用时 1 分 41 秒/);
  assert.match(message, /2 次请求超时或被中止/);
  assert.doesNotMatch(message, /5 分钟/);
});

test("TikTok parser diagnostics distinguish raw search results from usable profile candidates", () => {
  const stats = {
    rawResults: 0,
    profileCandidates: 0,
    parsedCandidates: 0,
    candidateFiltered: 0,
    negativeFiltered: 0
  };
  const creators = __testing.parseSearchPage({
    sourceProvider: "serper",
    results: [
      {
        url: "https://m.tiktok.com/@skin.creator/video/123",
        title: "Skin Creator on TikTok",
        snippet: "skincare routine and beauty reviews"
      },
      {
        url: "https://example.com/not-tiktok",
        title: "Other result",
        snippet: "not a profile"
      }
    ]
  }, "site:tiktok.com/@ skincare creator", {
    positiveTerms: ["skincare", "beauty", "review"],
    negativeTerms: [],
    normalizedBrief: { rawText: "skincare beauty review creator" }
  }, "serper", stats);

  assert.equal(creators.length, 1);
  assert.equal(creators[0].handle, "@skin.creator");
  assert.equal(stats.rawResults, 2);
  assert.equal(stats.profileCandidates, 1);
  assert.equal(stats.parsedCandidates, 1);
});

test("TikTok negative filtering ignores search query exclude operators", () => {
  const stats = {
    rawResults: 0,
    profileCandidates: 0,
    parsedCandidates: 0,
    candidateFiltered: 0,
    negativeFiltered: 0
  };
  const creators = __testing.parseSearchPage({
    sourceProvider: "serper",
    results: [
      {
        url: "https://www.tiktok.com/@pretty.friend",
        title: "Pretty girl creator",
        snippet: "颜值 交友 黑丝 fashion creator"
      },
      {
        url: "https://www.tiktok.com/@adult.shop",
        title: "Adult shop",
        snippet: "adult store"
      }
    ]
  }, "site:tiktok.com/@ 颜值 交友 女 黑丝 -adult -shop -store", {
    positiveTerms: ["颜值", "交友", "女", "黑丝"],
    negativeTerms: ["adult", "shop", "store"],
    normalizedBrief: { rawText: "颜值,交友,女,黑丝" }
  }, "serper", stats);

  assert.deepEqual(creators.map((creator) => creator.handle), ["@pretty.friend"]);
  assert.equal(stats.rawResults, 2);
  assert.equal(stats.profileCandidates, 2);
  assert.equal(stats.parsedCandidates, 1);
  assert.equal(stats.negativeFiltered, 1);
});

test("TikTok parser falls back from tag-like titles and keeps snippet as bio evidence", () => {
  const stats = {
    rawResults: 0,
    profileCandidates: 0,
    parsedCandidates: 0,
    candidateFiltered: 0,
    negativeFiltered: 0
  };
  const [creator] = __testing.parseSearchPage({
    sourceProvider: "serper",
    results: [{
      url: "https://www.tiktok.com/@pretty.friend",
      title: "#颜值 #交友 #黑丝 | TikTok",
      snippet: "颜值 交友 黑丝 fashion creator with daily outfit videos",
      imageUrl: "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/avatar.jpeg"
    }]
  }, "site:tiktok.com/@ 颜值 交友 女 黑丝", {
    positiveTerms: ["颜值", "交友", "女", "黑丝"],
    negativeTerms: [],
    normalizedBrief: { rawText: "颜值,交友,女,黑丝" }
  }, "serper", stats);

  assert.equal(creator.name, "pretty.friend");
  assert.equal(creator.bio, "颜值 交友 黑丝 fashion creator with daily outfit videos");
  assert.equal(creator.avatarUrl, "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/avatar.jpeg");
  assert.deepEqual(creator.tags, ["颜值", "交友", "黑丝"]);
  assert.equal(stats.parsedCandidates, 1);
});

test("TikTok parser treats Make Your Day as boilerplate display name", () => {
  const stats = {
    rawResults: 0,
    profileCandidates: 0,
    parsedCandidates: 0,
    candidateFiltered: 0,
    negativeFiltered: 0
  };
  const [creator] = __testing.parseSearchPage({
    sourceProvider: "serper",
    results: [{
      url: "https://www.tiktok.com/@pretty.friend",
      title: "TikTok - Make Your Day",
      snippet: "颜值 交友 黑丝 creator with 2.5K followers"
    }]
  }, "site:tiktok.com/@ 颜值 交友 女 黑丝", {
    positiveTerms: ["颜值", "交友", "女", "黑丝"],
    negativeTerms: [],
    normalizedBrief: { rawText: "颜值,交友,女,黑丝" }
  }, "serper", stats);

  assert.equal(creator.name, "pretty.friend");
  assert.equal(creator.metrics.followers, 2500);
});

test("TikTok public profile parser reads embedded stats and avatar", () => {
  const profile = __testing.parsePublicTikTokProfile(`
    <html>
      <head>
        <title>TikTok - Make Your Day</title>
        <script id="SIGI_STATE" type="application/json">
          {
            "UserModule": {
              "users": {
                "pretty.friend": {
                  "id": "1",
                  "uniqueId": "pretty.friend",
                  "nickname": "Pretty Friend",
                  "signature": "颜值 交友 黑丝 daily outfits",
                  "avatarLarger": "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/avatar.jpeg"
                }
              },
              "stats": {
                "pretty.friend": {
                  "followerCount": 3456,
                  "followingCount": 12,
                  "heartCount": 78900,
                  "videoCount": 45
                }
              }
            }
          }
        </script>
      </head>
    </html>
  `, "@pretty.friend");

  assert.equal(profile.name, "Pretty Friend");
  assert.equal(profile.bio, "颜值 交友 黑丝 daily outfits");
  assert.equal(profile.avatarUrl, "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/avatar.jpeg");
  assert.equal(profile.followers, 3456);
});

function createTestLogger(entries) {
  return {
    info(event, fields = {}) {
      entries.push({ level: "info", event, fields });
    },
    warn(event, fields = {}) {
      entries.push({ level: "warn", event, fields });
    },
    error(event, fields = {}) {
      entries.push({ level: "error", event, fields });
    }
  };
}

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
